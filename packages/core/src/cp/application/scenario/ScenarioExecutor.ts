import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioExecutionState,
  ScenarioExecutionMode,
  ScenarioExecutorCallbacks,
  ScenarioEvents,
  ScenarioNode,
  StartTransactionOptions,
  StopTransactionOptions,
  ScenarioWaitIntervention,
} from "./ScenarioTypes";
import { ScenarioNodeType } from "./ScenarioTypes";
import { type FromScope } from "./resolveFrom";
import {
  createScenarioMachine,
  getScenarioStateName,
  getScenarioContext,
  type ScenarioMachineService,
} from "../state/machines/ScenarioStateMachine";
import { interpret } from "robot3";
import { BranchScope, ParallelRegion } from "./branchScope";
import type { WaitControl } from "./WaitControl";
import { type WaitSignal } from "./WaitControl";
import type { Flow, NodeRunContext, ParkedWait } from "./nodes/context";
import { pickCase } from "./nodes/branching";
import { executeNode } from "./nodes/dispatch";
import {
  sleep,
  waitForStep,
  waitIfPaused,
  waitWithOptionalForceSkip,
  waitWithProgress,
} from "./waits";
import { ScenarioRunStateError } from "../../domain/errors/ScenarioRunStateError";
import type { EventEmitter } from "../../shared/EventEmitter";
import { realClock } from "../../shared/clock";
import type { SimClock } from "../../shared/clock";
import { systemRngStreams } from "../../shared/rng";
import type { Rng } from "../../shared/rng";
import {
  isTerminal,
  loopBounds,
  loopStep,
  lowerScenario,
  isJoin,
  joinMode,
  nextStep,
  resolveOrigin,
  successors,
  type ScenarioProgram,
} from "../../../scenario/scenarioGraph";
import { connectionRule } from "../../../scenario/scenarioConnectionRules";

type ScenarioEdge = ScenarioDefinition["edges"][number];

const newFlow = (scope: BranchScope): Flow => ({
  exchange: null,
  answered: false,
  response: null,
  handle: null,
  timeoutTarget: null,
  scope,
  loops: new Map(),
});

/** Time and randomness a scenario run reads; the platform's by default. */
export interface ScenarioExecutorSimOptions {
  readonly clock?: SimClock;
  readonly rng?: Rng;
}

/**
 * Optional resume hint passed to {@link ScenarioExecutor.start}. When set
 * the executor skips the normal walk from the `start` node and instead
 * resumes from the outgoing edge of `resumeFromNodeId`. Intended for the
 * daemon-restart path that loads a {@link ScenarioPositionSnapshot} from
 * the connector_runtime persistence and reattaches an executor to it.
 *
 * If `resumeFromNodeId` doesn't exist in the scenario graph (because the
 * scenario was edited between runs) the executor logs a warning and
 * falls back to a fresh start from `start` — the safe default; the next
 * RemoteStartTransaction will re-arm the connector cleanly.
 */
export interface ScenarioStartOptions {
  mode?: ScenarioExecutionMode;
  resumeFromNodeId?: string;
  /** Seed for `context.executedNodes`. Lets branching-history checks
   *  (the ones that look at "have we executed node X already?") behave
   *  consistently after resume. Optional; defaults to a list containing
   *  just `resumeFromNodeId`. */
  executedNodes?: string[];
}

export class ScenarioExecutor {
  private scenario: ScenarioDefinition;
  private callbacks: ScenarioExecutorCallbacks;
  private service: ScenarioMachineService;
  private stepResolve: (() => void) | null = null;
  private pendingSteps = 0;
  private previousState: ScenarioExecutionState = "idle";
  private eventEmitter?: EventEmitter<ScenarioEvents>;
  private forceSkipResolve: (() => void) | null = null;
  // Abort plumbing: stop() flips `aborted` and resolves `abortPromise` so any
  // in-flight wait (auto-meter maxTime, delay, status/meter waits) unblocks
  // immediately and the flow walker bails before running the next node.
  // Without this a stopped scenario's maxTime timer fires later and a stale
  // "Stop Transaction" node ends an unrelated charge on the same connector.
  private aborted = false;
  private abortResolve: (() => void) | null = null;
  private abortPromise: Promise<void> = Promise.resolve();
  /** The run's cancellation scope; it ends with `abortPromise` (schema 1.9). */
  private rootScope: BranchScope = BranchScope.root(this.abortPromise);
  private remoteStartTagId: string | null = null;
  private remoteStartOptions: StartTransactionOptions | null = null;
  // Reason captured from the most recent RemoteStopTrigger node, forwarded
  // to the next Transaction Stop's StopTransaction.req so the CSMS sees
  // "Remote" (§6.21) for RemoteStop-driven stops instead of a blank
  // reason. Cleared as soon as the stop node consumes it.
  private remoteStopReason: string | null = null;
  private remoteStopOptions: StopTransactionOptions | null = null;
  private currentNodeId: string | null = null;
  // #240: epoch ms when the current node began executing; null when no
  // node is active. Lets a client compute time-on-step and, with
  // expectation.timeoutMs, the remaining wait.
  private currentNodeStartedAt: number | null = null;
  // #179 / #240: the trigger waits currently parked, oldest first, each with
  // the condition it awaits and the deadline and operator controls (extend /
  // retry / continue) of its armed attempt. The robot3 machine stays
  // "running" while a node parks (its "waiting" state is never entered), so
  // getContext() derives the reported "waiting" state from this list.
  // Parallel branches can park several; the latest still parked is the one
  // reported and controlled.
  private parkedWaits: ParkedWait[] = [];
  private executedNodes: string[] = [];
  // Issue #110: track which response overrides were armed during this run,
  // so they can be cleared when the run ends (both normal completion and stop()).
  private armedOverrideActions: string[] = [];
  // Issue #247: track which inbound policies were armed during this run,
  // so they can be cleared when the run ends (both normal completion and stop()).
  private armedInboundPolicyActions: string[] = [];
  // Issue #247 Phase 3: track whether certificate quirks were armed during this
  // run, so they can be cleared when the run ends (both normal completion and stop()).
  private armedCertificateQuirks = false;
  private readonly clock: SimClock;
  private readonly rng: Rng;
  /** The state of the run (schema 1.6 `setState`); fresh for every start. */
  private runState: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  /** The scenario lowered for walking (scenarioGraph.ts); rebuilt when the
   *  definition's node or edge array is replaced. */
  private lowered: ScenarioProgram<ScenarioNode, ScenarioEdge> | null = null;
  /** What the extracted node and wait functions read of this run (nodes/context.ts). */
  private readonly nodeCtx: NodeRunContext;

  constructor(
    scenario: ScenarioDefinition,
    callbacks: ScenarioExecutorCallbacks,
    eventEmitter?: EventEmitter<ScenarioEvents>,
    sim: ScenarioExecutorSimOptions = {},
  ) {
    this.scenario = scenario;
    this.callbacks = callbacks;
    this.eventEmitter = eventEmitter;
    this.clock = sim.clock ?? realClock;
    this.rng =
      sim.rng ??
      systemRngStreams.stream(String(scenario.targetId ?? ""), "scenario");

    // Create robot3 state machine
    const machine = createScenarioMachine({
      scenarioId: scenario.id,
      mode: "oneshot",
      currentNodeId: null,
      executedNodes: [],
      loopCount: 0,
    });

    // Create service to manage machine and emit state change events
    this.service = interpret(machine, (service) => {
      const currentState = getScenarioStateName(
        service,
      ) as ScenarioExecutionState;

      // Emit state change event if state actually changed
      if (currentState !== this.previousState) {
        const eventData = {
          scenarioId: this.scenario.id,
          state: currentState,
          previousState: this.previousState,
        };

        // Emit backward-compatible event
        this.eventEmitter?.emit("stateChange", eventData);

        // Emit hierarchical events with EventEmitter2
        // state.{stateName} - Specific state transition
        this.eventEmitter?.emit(
          `state.${currentState}` as keyof ScenarioEvents,
          {
            scenarioId: this.scenario.id,
            previousState: this.previousState,
          },
        );

        this.previousState = currentState;
      }
    });

    this.nodeCtx = this.createNodeContext();
  }

  private createNodeContext(): NodeRunContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getters read the live fields
    const host = this;
    const ctx: NodeRunContext = {
      get scenario() {
        return host.scenario;
      },
      get callbacks() {
        return host.callbacks;
      },
      get eventEmitter() {
        return host.eventEmitter;
      },
      get clock() {
        return host.clock;
      },
      get rng() {
        return host.rng;
      },
      get runState() {
        return host.runState;
      },
      get armedOverrideActions() {
        return host.armedOverrideActions;
      },
      get armedInboundPolicyActions() {
        return host.armedInboundPolicyActions;
      },
      get parkedWaits() {
        return host.parkedWaits;
      },
      get aborted() {
        return host.aborted;
      },
      get remoteStartTagId() {
        return host.remoteStartTagId;
      },
      set remoteStartTagId(value) {
        host.remoteStartTagId = value;
      },
      get remoteStartOptions() {
        return host.remoteStartOptions;
      },
      set remoteStartOptions(value) {
        host.remoteStartOptions = value;
      },
      get remoteStopReason() {
        return host.remoteStopReason;
      },
      set remoteStopReason(value) {
        host.remoteStopReason = value;
      },
      get remoteStopOptions() {
        return host.remoteStopOptions;
      },
      set remoteStopOptions(value) {
        host.remoteStopOptions = value;
      },
      get stepResolve() {
        return host.stepResolve;
      },
      set stepResolve(value) {
        host.stepResolve = value;
      },
      get pendingSteps() {
        return host.pendingSteps;
      },
      set pendingSteps(value) {
        host.pendingSteps = value;
      },
      get forceSkipResolve() {
        return host.forceSkipResolve;
      },
      set forceSkipResolve(value) {
        host.forceSkipResolve = value;
      },
      stateName: () => getScenarioStateName(host.service),
      sendStep: () => {
        host.service.send({ type: "STEP" });
      },
      markCertificateQuirksArmed: () => {
        host.armedCertificateQuirks = true;
      },
      unpark: (control) => host.unpark(control),
      notifyStateChange: () => host.notifyStateChange(),
      program: () => host.program(),
      fromScope: (flow) => host.fromScope(flow),
      waitWithOptionalForceSkip: (waitPromise, scope) =>
        waitWithOptionalForceSkip(ctx, waitPromise, scope),
      sleep: (ms, scope) => sleep(ctx, ms, scope),
      waitWithProgress: (nodeId, totalSeconds, scope) =>
        waitWithProgress(ctx, nodeId, totalSeconds, scope),
    };
    return ctx;
  }

  /**
   * Start scenario execution. Defaults to one-shot execution unless the caller
   * explicitly requests step mode.
   */
  public async start(opts?: ScenarioStartOptions): Promise<void> {
    const mode: ScenarioExecutionMode = opts?.mode ?? "oneshot";
    // Fresh abort gate for this run.
    this.aborted = false;
    this.currentNodeId = null;
    this.currentNodeStartedAt = null;
    this.parkedWaits = [];
    this.executedNodes = [];
    this.runState = Object.create(null) as Record<string, unknown>;
    this.stepResolve = null;
    this.pendingSteps = 0;
    this.armedOverrideActions = [];
    this.armedInboundPolicyActions = [];
    this.abortPromise = new Promise<void>((resolve) => {
      this.abortResolve = resolve;
    });
    this.rootScope = BranchScope.root(this.abortPromise);
    // Dispatch START event to transition to running state
    this.service.send({ type: "START", mode });
    this.notifyStateChange();

    // Emit execution started events
    const startedData = {
      scenarioId: this.scenario.id,
      mode,
    };
    this.eventEmitter?.emit("executionStarted", startedData); // Backward compatibility
    this.eventEmitter?.emit("execution.started", startedData); // Hierarchical event

    // Log scenario start
    this.callbacks.log?.(
      `[${this.scenario.name}] Scenario execution started (mode: ${mode})`,
      "info",
    );

    // Apply the scenario's declarative EV settings (if any) before the
    // first node runs, so meterValue / battery visualization /
    // checkAutoStop all see the scenario's intended EV from the get-go.
    if (this.scenario.evSettings && this.callbacks.onSetEVSettings) {
      try {
        await this.callbacks.onSetEVSettings(this.scenario.evSettings);
      } catch (err) {
        this.callbacks.log?.(
          `[${this.scenario.name}] Failed to apply scenario evSettings: ${
            err instanceof Error ? err.message : String(err)
          }`,
          "warn",
        );
      }
    }

    try {
      await this.executeFlow(opts);

      // Check if we were stopped during execution
      const stateName = getScenarioStateName(this.service);
      if (stateName !== "idle") {
        // Dispatch FLOW_COMPLETE event to transition to completed state
        this.service.send({ type: "FLOW_COMPLETE" });

        // Emit execution completed events
        const completedData = { scenarioId: this.scenario.id };
        this.eventEmitter?.emit("executionCompleted", completedData); // Backward compatibility
        this.eventEmitter?.emit("execution.completed", completedData); // Hierarchical event

        // Log scenario completion
        this.callbacks.log?.(
          `[${this.scenario.name}] Scenario execution completed`,
          "info",
        );
      }
    } catch (error) {
      // Dispatch ERROR event to transition to error state
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.service.send({ type: "ERROR", error: errorMessage });
      this.callbacks.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );

      // Emit execution error events
      const errorData = {
        scenarioId: this.scenario.id,
        error: errorMessage,
      };
      this.eventEmitter?.emit("executionError", errorData); // Backward compatibility
      this.eventEmitter?.emit("execution.error", errorData); // Hierarchical event

      // Log scenario error
      this.callbacks.log?.(
        `[${this.scenario.name}] Scenario execution failed: ${errorMessage}`,
        "error",
      );
    } finally {
      // Issue #110: clear any response overrides armed during this run,
      // both on normal completion and on stop(). Iterate through the
      // tracking list (which was populated by executeResponseOverride)
      // and call the clear callback for each one.
      for (const action of this.armedOverrideActions) {
        this.callbacks.onClearResponseOverride?.(action);
      }
      this.armedOverrideActions = [];

      // Issue #247: clear any inbound policies armed during this run,
      // both on normal completion and on stop(). Iterate through the
      // tracking list (which was populated by executeInboundPolicy)
      // and call the clear callback for each one.
      for (const action of this.armedInboundPolicyActions) {
        this.callbacks.onClearInboundPolicy?.(action);
      }
      this.armedInboundPolicyActions = [];

      // Issue #247 Phase 3: clear any certificate quirks armed during this run.
      if (this.armedCertificateQuirks) {
        this.callbacks.onClearCertificateQuirks?.();
        this.armedCertificateQuirks = false;
      }

      // Schema 1.5 (#566): release the CALL rules this run armed and answer
      // the CALLs it still owns.
      this.callbacks.onRunEnded?.();

      this.notifyStateChange();
    }
  }

  /**
   * Execute the flow from start to end
   * Supports scenarios with internal loops - use Stop button to exit infinite loops
   * Supports parallel branches from Start node
   *
   * If `opts.resumeFromNodeId` is supplied AND the node exists, the executor
   * resumes from the outgoing edge of that node — the START node and every
   * node up to `resumeFromNodeId` are treated as already executed and are
   * NOT re-fired. Used by the daemon restart path so side-effecting nodes
   * (Plug In, Start Transaction, …) don't double-emit OCPP traffic.
   */
  private async executeFlow(opts?: ScenarioStartOptions): Promise<void> {
    const resumeFromNodeId = opts?.resumeFromNodeId;
    let originNode: ScenarioNode | undefined;
    let resumed = false;

    const program = this.program();
    if (resumeFromNodeId) {
      originNode = program.nodesById.get(resumeFromNodeId);
      if (originNode) {
        // Seed executedNodes from the resume snapshot so any node-history
        // check inside an executor down the flow has the right shape.
        // Fall back to `[resumeFromNodeId]` when the caller didn't provide
        // the full list (it's only used for diagnostics in most nodes).
        const seededNodes =
          opts?.executedNodes && opts.executedNodes.length > 0
            ? [...opts.executedNodes]
            : [resumeFromNodeId];
        this.executedNodes = seededNodes;
        this.currentNodeId = originNode.id;
        this.currentNodeStartedAt = this.clock.now();
        resumed = true;
        this.callbacks.log?.(
          `[${this.scenario.name}] Resuming scenario from node "${
            originNode.data?.label || originNode.id
          }"`,
          "info",
        );
      } else {
        // Scenario tree changed between persistence and resume; fall
        // through to a fresh run. Logged at warn so an operator sees it.
        this.callbacks.log?.(
          `[${this.scenario.name}] Cannot resume: node "${resumeFromNodeId}" no ` +
            "longer exists in scenario; falling back to fresh start",
          "warn",
        );
      }
    }

    if (!originNode) {
      // Normal path: find and execute the Start node.
      originNode = resolveOrigin(program);
      if (!originNode) {
        throw new Error("No start node found in scenario");
      }
      const originFlow = newFlow(this.rootScope);
      await this.executeSingleNode(originNode, originFlow);
      if (originFlow.timeoutTarget) {
        // Schema 1.8: an origin that is a timed-out wait (a legacy wait
        // labelled "Start") leaves by its timeout edge alone.
        const target = originFlow.timeoutTarget;
        originFlow.timeoutTarget = null;
        await this.executeSequentialFlow(target, originFlow);
        this.currentNodeId = null;
        this.currentNodeStartedAt = null;
        return;
      }
    }

    // Walk outgoing edges from the origin node (whether Start or resume).
    const nextNodes = successors(program, originNode, { asOrigin: true }).map(
      (edge) => program.nodesById.get(edge.target)!,
    );

    const originOut = connectionRule(originNode.type).out;
    if (resumed && (originOut === "select" || originOut === "fork")) {
      // The chosen handle is not persisted: decide again (a choice from its
      // seeded stream), then go on along that one edge. A parallel (schema
      // 1.9) runs again: it has no effect of its own, and its branches then
      // meet at their join as in a fresh run.
      await this.executeSequentialFlow(originNode, newFlow(this.rootScope));
      this.currentNodeId = null;
      this.currentNodeStartedAt = null;
      return;
    }

    if (nextNodes.length === 0) {
      const tag = resumed ? "Resume point" : "Start";
      this.callbacks.log?.(
        `[${this.scenario.name}] No nodes after ${tag}, scenario ends`,
        resumed ? "info" : "warn",
      );
      return;
    }

    if (nextNodes.length === 1) {
      // Single branch - execute sequentially
      this.callbacks.log?.(
        `[${this.scenario.name}] Executing single branch`,
        "debug",
      );
      await this.executeSequentialFlow(nextNodes[0]!, newFlow(this.rootScope));
    } else {
      // Multiple branches - execute in parallel
      this.callbacks.log?.(
        `[${this.scenario.name}] Executing ${nextNodes.length} parallel branches`,
        "info",
      );
      await this.executeParallelBranches(nextNodes);
    }

    // Clear current node
    this.currentNodeId = null;
    this.currentNodeStartedAt = null;
  }

  /**
   * The lowered scenario, rebuilt only when `nodes` or `edges` is replaced.
   *
   * Invariant: while a run is live, `scenario.nodes` / `scenario.edges` (and
   * the node and edge objects in them) are replaced, never mutated in place.
   * The cache is keyed on the two arrays' identity, so an in-place push,
   * splice or edit of an edge would not be seen: `executeFlow` (origin and
   * resume point) and `executeSequentialFlow` (`nextStep` after every node)
   * would keep walking the graph as it was lowered. Neither the executor nor
   * its callers write to them (the console editor and a `--watch` reload
   * build new arrays); the permissive test "never mutates the definition's
   * node and edge arrays" freezes them to keep the executor honest.
   */
  private program(): ScenarioProgram<ScenarioNode, ScenarioEdge> {
    const { nodes, edges } = this.scenario;
    if (
      !this.lowered ||
      this.lowered.nodes !== nodes ||
      this.lowered.edges !== edges
    ) {
      this.lowered = lowerScenario({ nodes, edges });
    }
    return this.lowered;
  }

  /**
   * Execute multiple branches in parallel
   * Each branch runs independently until it reaches an End node or terminates
   */
  private async executeParallelBranches(
    startNodes: ScenarioNode[],
  ): Promise<void> {
    const branches = startNodes.map((node, index) => {
      this.callbacks.log?.(
        `[${this.scenario.name}] Starting branch ${index + 1} from node: ${node.data?.label || node.id}`,
        "debug",
      );
      return this.executeSequentialFlow(node, newFlow(this.rootScope));
    });

    // Wait for all branches to complete
    await Promise.all(branches);
    this.callbacks.log?.(
      `[${this.scenario.name}] All ${branches.length} parallel branches completed`,
      "info",
    );
  }

  /**
   * Execute a sequential flow starting from a given node
   */
  private async executeSequentialFlow(
    startNode: ScenarioNode,
    branchFlow: Flow,
  ): Promise<void> {
    let currentNode = startNode;
    let flow = branchFlow;
    // Schema 1.9: the join this branch goes on from after its parallel's
    // branches met there; it runs as a step, not as an arrival.
    let continuingJoin: ScenarioNode | null = null;
    // When this branch's walk began: the clock of a loop the branch is already
    // inside (it started or resumed in the body) counts from here.
    const walkStartedAt = this.clock.now();
    this.enterNode(currentNode, flow);

    while (
      currentNode &&
      !this.aborted &&
      getScenarioStateName(this.service) !== "idle"
    ) {
      if (flow.scope.cancelled) break;
      if (isJoin(currentNode) && currentNode !== continuingJoin) {
        const region = flow.scope.region;
        if (region) {
          // Schema 1.9: a branch a parallel started ends at a join.
          this.arriveAtJoin(currentNode, flow, region);
          return;
        }
        this.callbacks.log?.(
          `[${this.scenario.name}] Join "${currentNode.data?.label || currentNode.id}" reached by a branch no parallel started; it runs as a plain step`,
          "info",
        );
      }
      continuingJoin = null;

      // Execute the current node
      await this.executeSingleNode(currentNode, flow);

      // If the node finished while paused, do not make the next node visible
      // until the run has been resumed. Stop/abort can also land while parked.
      await waitIfPaused(this.nodeCtx, flow.scope);
      if (this.aborted || getScenarioStateName(this.service) === "idle") {
        break;
      }
      if (flow.scope.cancelled) break;

      // Schema 1.8: a wait that timed out goes on along its timeout edge.
      const timedOutTo = flow.timeoutTarget;
      flow.timeoutTarget = null;
      if (timedOutTo) {
        flow.handle = null;
        currentNode = timedOutTo;
        this.enterNode(currentNode, flow);
        continue;
      }

      // Check if this is the end node
      if (isTerminal(currentNode)) {
        break;
      }

      // Schema 1.9: a parallel forks; this branch waits for its branches to
      // meet at a join and goes on from there with a fresh flow.
      if (connectionRule(currentNode.type).out === "fork") {
        const join = await this.runParallel(currentNode, flow);
        if (!join) break;
        flow = newFlow(flow.scope);
        currentNode = join;
        continuingJoin = join;
        continue;
      }

      // Find next node. A switch or choice picked one edge by its handle
      // (schema 1.6).
      const handle = flow.handle;
      flow.handle = null;

      // Schema 1.10: a loop edge out of this node, after its round. Going
      // round again keeps the loop's state; exiting drops it and the branch
      // goes on along the node's ordinary edge, if any.
      const loop =
        handle === null ? loopStep(this.program(), currentNode) : null;
      if (
        loop &&
        !this.loopExits(loop.edge, currentNode, flow, walkStartedAt)
      ) {
        currentNode = loop.target;
        continue;
      }

      const step = nextStep(this.program(), currentNode, handle);
      if (step.kind === "noEdgeForHandle") {
        this.callbacks.log?.(
          `[${this.scenario.name}] "${currentNode.data?.label || currentNode.id}" chose "${handle}", which has no edge; the branch ends`,
          "info",
        );
        break;
      }
      if (step.kind === "missingTargets") {
        console.warn(
          `[ScenarioExecutor] All outgoing edges from node ${currentNode!.id} point to non-existent nodes. Branch will end here.`,
        );
        break;
      }
      if (step.kind !== "edge") {
        break; // No more nodes to execute
      }

      currentNode = step.target;
      this.enterNode(currentNode, flow);
    }

    if (flow.scope.cancelled && !this.aborted) {
      this.callbacks.log?.(
        `[${this.scenario.name}] Branch at "${currentNode.data?.label || currentNode.id}" cancelled: another branch reached an "any" join first, or a sibling failed`,
        "info",
      );
      this.dropOpenCall(flow, "cancelled the branch");
    }
  }

  /**
   * Schema 1.9: answer the CALL a branch still holds unanswered with
   * `InternalError` now, because its flow is dropped (the branch was
   * cancelled, reached a join, or forked at a parallel). Does not wait for
   * the answer to settle.
   */
  private dropOpenCall(flow: Flow, why: string): void {
    const exchange = flow.exchange;
    if (!exchange || flow.answered) return;
    flow.answered = true;
    this.callbacks.log?.(
      `${exchange.action}: the scenario ${why} before it answered this call; answering InternalError`,
      "warn",
    );
    try {
      void exchange
        .answer({
          kind: "error",
          errorCode: "InternalError",
          errorDescription: `The scenario ${why} before it answered this call`,
        })
        .catch(() => undefined);
    } catch {
      // An answer that cannot be sent is the runtime's to report.
    }
  }

  /** Schema 1.9: a branch of `region` reached `join`; the branch ends here. */
  private arriveAtJoin(
    join: ScenarioNode,
    flow: Flow,
    region: ParallelRegion,
  ): void {
    const mode = joinMode(join);
    this.callbacks.log?.(
      `[${this.scenario.name}] A branch of "${region.parallelNodeId}" reached join "${join.data?.label || join.id}" (${mode})`,
      "debug",
    );
    this.dropOpenCall(flow, "reached a join");
    region.arrive(join, mode);
  }

  /**
   * Schema 1.9: run every outgoing ordinary edge of `node` (a `parallel`) as
   * its own branch, each with a fresh flow and a child scope, and wait until
   * they meet. Resolves with the join to go on from, or null when no branch
   * reached one (or this branch was cancelled, or the run stopped). A branch
   * that fails cancels its siblings and fails the run.
   */
  private async runParallel(
    node: ScenarioNode,
    flow: Flow,
  ): Promise<ScenarioNode | null> {
    const program = this.program();
    const targets = successors(program, node).map((edge) =>
      program.nodesById.get(edge.target)!,
    );
    const label = node.data?.label || node.id;
    // The flow after the join is fresh: the CALL held here is dropped.
    this.dropOpenCall(flow, "forked the branch at a parallel");
    const region = new ParallelRegion(node.id);
    this.callbacks.log?.(
      `[${this.scenario.name}] "${label}" starts ${targets.length} parallel branches`,
      "info",
    );
    for (const target of targets) {
      const scope = flow.scope.child(region);
      region.addBranch(scope);
      this.executeSequentialFlow(target, newFlow(scope)).then(
        () => {
          scope.release();
          region.branchEnded();
        },
        (error: unknown) => {
          scope.release();
          if (region.isSettled) {
            this.callbacks.log?.(
              `[${this.scenario.name}] A cancelled branch of "${label}" failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              "warn",
            );
          }
          region.fail(error);
        },
      );
    }
    region.empty();

    const outcome = await Promise.race([
      region.settled,
      flow.scope.ended.then(() => null),
    ]);
    // Whatever settled it, nothing of this execution runs on: an `any` join
    // cancels the other branches, a failure its siblings, a stop everything.
    for (const branch of region.branches) branch.cancel();
    if (outcome === null || this.aborted) return null;
    if (outcome.kind === "failed") throw outcome.error;
    if (outcome.kind === "noJoin") {
      this.callbacks.log?.(
        `[${this.scenario.name}] No branch of "${label}" reached a join; the branch ends`,
        "info",
      );
      return null;
    }
    this.callbacks.log?.(
      `[${this.scenario.name}] The branches of "${label}" met at "${
        (outcome.join as ScenarioNode).data?.label || outcome.join.id
      }" (${joinMode(outcome.join)})`,
      "info",
    );
    return outcome.join as ScenarioNode;
  }

  /**
   * The branch arrives at `node` by anything but a loop edge (an ordinary
   * edge, or the walk starting there): every loop edge back to `node` begins
   * afresh, so a nested loop restarts when the outer body enters it again.
   */
  private enterNode(node: ScenarioNode, flow: Flow): void {
    const loops = this.program().loopEdgesInto.get(node.id);
    if (!loops) return;
    const since = this.clock.now();
    for (const edge of loops) flow.loops.set(edge.id, { rounds: 0, since });
  }

  /**
   * Schema 1.10: the end-of-round check of a loop edge, right after its
   * source ran (do-while): count the round, then exit when `times` rounds are
   * done, `forSeconds` have passed on the station clock since the loop was
   * entered, or `until` matches one of its cases, as a switch does. Without a
   * bound the loop never exits. A malformed `loop` fails the run here.
   */
  private loopExits(
    edge: ScenarioEdge,
    source: ScenarioNode,
    flow: Flow,
    walkStartedAt: number,
  ): boolean {
    const read = loopBounds(edge);
    if ("problem" in read) {
      throw new Error(`loop edge "${edge.id}": ${read.problem}`);
    }
    const { times, forSeconds, until } = read.bounds;
    let state = flow.loops.get(edge.id);
    if (!state) {
      state = { rounds: 0, since: walkStartedAt };
      flow.loops.set(edge.id, state);
    }
    state.rounds += 1;
    let fired: string | null = null;
    if (times !== undefined && state.rounds >= times) {
      fired = `times ${times}`;
    } else if (
      forSeconds !== undefined &&
      this.clock.now() - state.since >= forSeconds * 1000
    ) {
      fired = `forSeconds ${forSeconds}`;
    } else if (until) {
      const picked = pickCase(
        this.nodeCtx,
        `loop edge "${edge.id}" until`,
        until.value,
        until.cases,
        flow,
      );
      if (picked.index >= 0) fired = `until case ${picked.index}`;
    }
    if (fired === null) return false;
    flow.loops.delete(edge.id);
    this.callbacks.log?.(
      `Loop "${edge.id}" out of "${source.data?.label || source.id}" exits (${fired}) after ${state.rounds} round${state.rounds === 1 ? "" : "s"}`,
      "info",
    );
    return true;
  }

  /**
   * Execute a single node
   */
  private async executeSingleNode(
    node: ScenarioNode,
    flow: Flow,
  ): Promise<void> {
    // A stop() may have landed while the previous node was awaiting; never
    // start another node once aborted (or once the branch was cancelled).
    if (this.aborted || flow.scope.cancelled) {
      return;
    }

    // Do not make the node visible while paused. This protects the boundary
    // after an in-flight wait resolves under pause.
    await waitIfPaused(this.nodeCtx, flow.scope);
    if (
      this.aborted ||
      flow.scope.cancelled ||
      getScenarioStateName(this.service) === "idle"
    ) {
      return;
    }

    // Wait for step before marking/emitting the node so each step exposes
    // exactly one more node.
    const stateName = getScenarioStateName(this.service);
    if (stateName === "stepping") {
      await waitForStep(this.nodeCtx, flow.scope);
      if (
        this.aborted ||
        flow.scope.cancelled ||
        getScenarioStateName(this.service) === "idle"
      ) {
        return;
      }
    }

    // Update context with current node
    this.currentNodeId = node.id;
    this.currentNodeStartedAt = this.clock.now();
    this.executedNodes.push(node.id);

    this.notifyStateChange();
    this.callbacks.onNodeExecute?.(node.id);

    // Emit node execute events
    const nodeExecuteData = {
      scenarioId: this.scenario.id,
      nodeId: node.id,
      nodeType: node.type as ScenarioNodeType,
    };
    this.eventEmitter?.emit("nodeExecute", nodeExecuteData); // Backward compatibility
    this.eventEmitter?.emit("node.execute", nodeExecuteData); // Hierarchical event
    // Emit specific node type event: node.{nodeType}.execute
    this.eventEmitter?.emit(
      `node.${node.type}.execute` as keyof ScenarioEvents,
      nodeExecuteData,
    );

    // Execute node
    if (
      node.type !== ScenarioNodeType.START &&
      node.type !== ScenarioNodeType.END
    ) {
      await executeNode(this.nodeCtx, node, flow);
    }

    // Dispatch NODE_COMPLETE event
    this.service.send({ type: "NODE_COMPLETE", nodeId: node.id });

    // Emit node complete events
    const nodeCompleteData = {
      scenarioId: this.scenario.id,
      nodeId: node.id,
    };
    this.eventEmitter?.emit("nodeComplete", nodeCompleteData); // Backward compatibility
    this.eventEmitter?.emit("node.complete", nodeCompleteData); // Hierarchical event
    // Emit specific node type event: node.{nodeType}.complete
    this.eventEmitter?.emit(
      `node.${node.type}.complete` as keyof ScenarioEvents,
      nodeCompleteData,
    );
  }

  /**
   * Pause execution
   */
  public pause(): void {
    const stateName = getScenarioStateName(this.service);
    if (stateName === "running") {
      this.service.send({ type: "PAUSE" });
      this.notifyStateChange();

      // Emit execution paused events
      const pausedData = { scenarioId: this.scenario.id };
      this.eventEmitter?.emit("executionPaused", pausedData); // Backward compatibility
      this.eventEmitter?.emit("execution.paused", pausedData); // Hierarchical event
    }
  }

  /**
   * Resume execution
   */
  public resume(): void {
    const stateName = getScenarioStateName(this.service);
    if (stateName === "paused") {
      this.service.send({ type: "RESUME" });
      this.notifyStateChange();

      // Emit execution resumed events
      const resumedData = { scenarioId: this.scenario.id };
      this.eventEmitter?.emit("executionResumed", resumedData); // Backward compatibility
      this.eventEmitter?.emit("execution.resumed", resumedData); // Hierarchical event
    }
  }

  /**
   * Stop execution
   */
  public stop(): void {
    // Flip the abort gate first so in-flight waits unblock and the flow
    // walker bails before executing the next node.
    this.aborted = true;
    this.currentNodeId = null;
    this.currentNodeStartedAt = null;
    for (const wait of this.parkedWaits) wait.control.dispose();
    this.parkedWaits = [];
    this.abortResolve?.();
    // Stop the connector's auto-meter now; otherwise a pending maxTime/maxValue
    // could later resume the flow and fire a downstream Stop Transaction on a
    // charge that started after this scenario was stopped.
    this.callbacks.onStopAutoMeterValue?.();

    this.service.send({ type: "STOP" });
    this.notifyStateChange();

    // Emit execution stopped events
    const stoppedData = { scenarioId: this.scenario.id };
    this.eventEmitter?.emit("executionStopped", stoppedData); // Backward compatibility
    this.eventEmitter?.emit("execution.stopped", stoppedData); // Hierarchical event
  }

  /**
   * Execute next step (for step mode)
   */
  public step(): void {
    const stateName = getScenarioStateName(this.service);
    if (stateName !== "stepping") {
      return;
    }

    if (this.stepResolve) {
      const resolve = this.stepResolve;
      this.stepResolve = null;
      this.service.send({ type: "STEP" });
      resolve();
      return;
    }

    this.pendingSteps += 1;
  }

  /**
   * Force step even while waiting for trigger/meter events
   */
  public forceStep(): void {
    const stateName = getScenarioStateName(this.service);
    if (stateName !== "stepping") return;

    if (this.forceSkipResolve) {
      this.forceSkipResolve();
      this.forceSkipResolve = null;
    }

    if (this.stepResolve) {
      this.service.send({ type: "STEP" });
      this.stepResolve();
      this.stepResolve = null;
    }
  }

  /**
   * Get current execution context
   */
  public getContext(): ScenarioExecutionContext {
    const stateName = getScenarioStateName(this.service);
    const context = getScenarioContext(this.service);

    // #179: surface the already-valid "waiting" state — and the awaited
    // condition — from the parked wait. Only override an otherwise-"running"
    // machine so a paused / stepping / stopped scenario keeps its real state.
    // #240: while a wait is parked, the current node and its start time are
    // that wait's too, so the whole waiting context describes one node even
    // after a parallel branch moved the executor-wide fields elsewhere.
    const parked = this.parkedWaits.at(-1);
    const state: ScenarioExecutionState =
      parked && stateName === "running"
        ? "waiting"
        : (stateName as ScenarioExecutionState);

    return {
      scenarioId: context.scenarioId,
      state,
      mode: context.mode,
      currentNodeId: parked?.nodeId ?? this.currentNodeId,
      executedNodes: [...this.executedNodes],
      loopCount: context.loopCount,
      error: context.error,
      expectation: parked?.expectation ?? null,
      currentNodeStartedAt: parked?.startedAt ?? this.currentNodeStartedAt,
      waitDeadlineAt: parked?.control.deadlineAt ?? null,
    };
  }

  /** #240: push the parked wait's deadline back by `seconds`. */
  public extendWait(seconds: number): void {
    const wait = this.requireParkedWait();
    wait.control.extend(seconds * 1000);
    this.reportIntervention({
      kind: "extend",
      nodeId: wait.nodeId,
      at: this.clock.now(),
      seconds,
    });
  }

  /** #240: withdraw the parked wait and arm it again with its full timeout. */
  public retryWait(): void {
    this.signalWait("retry");
  }

  /** #240: treat the parked wait as satisfied and move on to the next node,
   *  without the awaited event (so nothing is captured from it). */
  public continueWait(): void {
    this.signalWait("continue");
  }

  private signalWait(kind: WaitSignal): void {
    const wait = this.requireParkedWait();
    this.unpark(wait.control);
    wait.control.request(kind);
    this.reportIntervention({
      kind,
      nodeId: wait.nodeId,
      at: this.clock.now(),
    });
  }

  private requireParkedWait(): ParkedWait {
    const wait = this.parkedWaits.at(-1);
    if (!wait) {
      throw new ScenarioRunStateError(
        `Scenario ${this.scenario.id} is not waiting`,
      );
    }
    return wait;
  }

  private unpark(control: WaitControl): void {
    this.parkedWaits = this.parkedWaits.filter((w) => w.control !== control);
  }

  private reportIntervention(intervention: ScenarioWaitIntervention): void {
    this.callbacks.log?.(
      `[${this.scenario.name}] Operator ${intervention.kind} on ${intervention.nodeId}${
        intervention.seconds !== undefined ? ` (+${intervention.seconds}s)` : ""
      }`,
      "info",
    );
    this.callbacks.onWaitIntervention?.(intervention);
    this.eventEmitter?.emit("wait.intervention", {
      scenarioId: this.scenario.id,
      ...intervention,
    });
    this.notifyStateChange();
  }

  /**
   * Notify state change
   */
  private notifyStateChange(): void {
    this.callbacks.onStateChange?.(this.getContext());
  }

  /** What a `$from` of this branch can read (schema 1.5, 1.6). */
  private fromScope(flow: Flow): FromScope {
    return {
      exchange: flow.exchange,
      response: flow.response,
      state: this.runState,
      ...(this.callbacks.onReadStation
        ? { station: this.callbacks.onReadStation }
        : {}),
    };
  }
}
