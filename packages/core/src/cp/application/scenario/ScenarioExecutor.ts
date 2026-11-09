import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioExecutionState,
  ScenarioExecutionMode,
  ScenarioExecutorCallbacks,
  ScenarioEvents,
  ScenarioNode,
  StatusChangeNodeData,
  TransactionNodeData,
  MeterValueNodeData,
  DelayNodeData,
  NotificationNodeData,
  ConnectorPlugNodeData,
  RemoteStartTriggerNodeData,
  RemoteStopTriggerNodeData,
  CsmsCallTriggerNodeData,
  StatusTriggerNodeData,
  ReserveNowNodeData,
  CancelReservationNodeData,
  ReservationTriggerNodeData,
  StatusNotificationNodeData,
  UnlockOutcomeNodeData,
  ResponseOverrideNodeData,
  InboundPolicyNodeData,
  CertQuirksNodeData,
  ConfigSetNodeData,
  DataTransferNodeData,
  OcppCallNodeData,
  CallResponseNodeData,
  UseBehaviorNodeData,
  NotifyNodeData,
  SwitchNodeData,
  ChoiceNodeData,
  SetStateNodeData,
  ScenarioCallExchange,
  ConnectionTriggerNodeData,
  StartTransactionOptions,
  StopTransactionOptions,
  ScenarioExpectation,
  ScenarioWaitIntervention,
} from "./ScenarioTypes";
import {
  NOTIFY_KINDS,
  ScenarioFlowNodeType,
  ScenarioNodeType,
} from "./ScenarioTypes";
import {
  isFromReference,
  resolveFrom,
  resolveFromOrMissing,
  type FromScope,
  type ScenarioOcppResponse,
} from "./resolveFrom";
import {
  DIAGNOSTICS_STATUSES,
  FIRMWARE_STATUSES,
  UPLOAD_LOG_STATUSES,
} from "@ocpp-cp-simulator/contracts/firmwareLogStatus";
import { jsonProblem } from "../behavior/paramsSchema";
import {
  MISSING,
  matchCase,
  matcherProblem,
} from "../../../scenario/valueMatch";
import { DEFAULT_ID_TAG } from "../../domain/auth/IdTagPool";
import { deriveExpectation } from "./ScenarioExpectations";
import {
  createScenarioMachine,
  getScenarioStateName,
  getScenarioContext,
  type ScenarioMachineService,
} from "../state/machines/ScenarioStateMachine";
import { interpret } from "robot3";
import { cancelIfCancellable } from "./cancellable";
import { BranchScope, ParallelRegion } from "./branchScope";
import { WaitControl, type WaitSignal } from "./WaitControl";
import { ScenarioRunStateError } from "../../domain/errors/ScenarioRunStateError";
import type { EventEmitter } from "../../shared/EventEmitter";
import { realClock } from "../../shared/clock";
import type { SimClock } from "../../shared/clock";
import { systemRngStreams } from "../../shared/rng";
import type { Rng } from "../../shared/rng";
import {
  isTerminal,
  lowerScenario,
  isJoin,
  joinMode,
  nextStep,
  resolveOrigin,
  successors,
  timeoutStep,
  type ScenarioProgram,
} from "../../../scenario/scenarioGraph";
import { connectionRule } from "../../../scenario/scenarioConnectionRules";

type ScenarioEdge = ScenarioDefinition["edges"][number];

type AutoMeterStartConfig = Parameters<
  NonNullable<ScenarioExecutorCallbacks["onStartAutoMeterValue"]>
>[0] & { sendMessage?: boolean };
type MeterValueCallbacks = ScenarioExecutorCallbacks & {
  onGetTransactionMeterStart?: () => number | null;
};

/** #240: a parked trigger wait — what it awaits and the controls of its
 *  armed attempt. */
interface ParkedWait {
  nodeId: string;
  control: WaitControl;
  expectation: ScenarioExpectation | null;
  /** Epoch ms the node started parking; restarts on a retry. */
  startedAt: number;
}

/**
 * What one branch of the run owns (schema 1.5, #566): the CALL its
 * `csmsCallTrigger` took over. Branches from Start get one each, so parallel
 * branches can own different CALLs; the run ends with it unanswered only after
 * the runtime answered `InternalError` (see `onRunEnded`).
 */
interface Flow {
  exchange: ScenarioCallExchange | null;
  answered: boolean;
  /**
   * The answer to the latest `ocppCall` of this branch (schema 1.7), for the
   * root `response`. Latest wins; a branch from Start begins without one.
   */
  response: ScenarioOcppResponse | null;
  /**
   * Set by a `switch` or `choice` node (schema 1.6): the `sourceHandle` of the
   * one edge the branch goes on along. Read and cleared by the walk.
   */
  handle: string | null;
  /**
   * Set by a trigger wait whose timeout expired and that has a timeout edge
   * (schema 1.8): the node the branch goes on to instead of failing. Read
   * and cleared by the walk.
   */
  timeoutTarget: ScenarioNode | null;
  /**
   * The branch's cancellation scope (schema 1.9): the run's root scope, or
   * the scope of a branch a `parallel` started. Every wait of the branch
   * races `scope.ended`.
   */
  scope: BranchScope;
}

const newFlow = (scope: BranchScope): Flow => ({
  exchange: null,
  answered: false,
  response: null,
  handle: null,
  timeoutTarget: null,
  scope,
});

const STATE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isMeterValueTimeout = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.startsWith("Timeout waiting for meter value:");

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
      await this.waitIfPaused(flow.scope);
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
    await this.waitIfPaused(flow.scope);
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
      await this.waitForStep(flow.scope);
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
      await this.executeNode(node, flow);
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
   * Execute a single node
   */
  private async executeNode(node: ScenarioNode, flow: Flow): Promise<void> {
    // Log node execution
    const nodeLabel = node.data?.label || node.id;
    this.callbacks.log?.(
      `[${this.scenario.name}] Executing node: ${nodeLabel} (${node.type})`,
      "debug",
    );

    switch (node.type) {
      case ScenarioNodeType.STATUS_CHANGE:
        await this.executeStatusChange(node.data as StatusChangeNodeData);
        break;

      case ScenarioNodeType.TRANSACTION:
        await this.executeTransaction(node.data as TransactionNodeData);
        break;

      case ScenarioNodeType.METER_VALUE:
        await this.executeMeterValue(
          node.id,
          node.data as MeterValueNodeData,
          flow.scope,
        );
        break;

      case ScenarioNodeType.DELAY:
        await this.executeDelay(
          node.id,
          node.data as DelayNodeData,
          flow.scope,
        );
        break;

      case ScenarioNodeType.NOTIFICATION:
        await this.executeNotification(node.data as NotificationNodeData);
        break;

      case ScenarioNodeType.CONNECTOR_PLUG:
        await this.executeConnectorPlug(node.data as ConnectorPlugNodeData);
        break;

      case ScenarioNodeType.REMOTE_START_TRIGGER:
        await this.executeRemoteStartTrigger(
          node.id,
          node.data as RemoteStartTriggerNodeData,
          flow,
        );
        break;

      case ScenarioNodeType.REMOTE_STOP_TRIGGER:
        await this.executeRemoteStopTrigger(
          node.id,
          node.data as RemoteStopTriggerNodeData,
          flow,
        );
        break;

      case ScenarioNodeType.STATUS_TRIGGER:
        await this.executeStatusTrigger(
          node.id,
          node.data as StatusTriggerNodeData,
          flow,
        );
        break;

      case ScenarioNodeType.RESERVE_NOW:
        await this.executeReserveNow(node.data as ReserveNowNodeData);
        break;

      case ScenarioNodeType.CANCEL_RESERVATION:
        await this.executeCancelReservation(
          node.data as CancelReservationNodeData,
        );
        break;

      case ScenarioNodeType.RESERVATION_TRIGGER:
        await this.executeReservationTrigger(
          node.id,
          node.data as ReservationTriggerNodeData,
          flow,
        );
        break;

      case ScenarioNodeType.CSMS_CALL_TRIGGER:
        await this.executeCsmsCallTrigger(
          node.id,
          node.data as CsmsCallTriggerNodeData,
          flow,
        );
        break;

      case ScenarioNodeType.STATUS_NOTIFICATION:
        await this.executeStatusNotification(
          node.data as StatusNotificationNodeData,
        );
        break;

      case ScenarioNodeType.UNLOCK_OUTCOME:
        await this.executeUnlockOutcome(node.data as UnlockOutcomeNodeData);
        break;

      case ScenarioNodeType.RESPONSE_OVERRIDE:
        await this.executeResponseOverride(
          node.data as ResponseOverrideNodeData,
        );
        break;

      case ScenarioNodeType.INBOUND_POLICY:
        await this.executeInboundPolicy(node.data as InboundPolicyNodeData);
        break;

      case ScenarioNodeType.CERT_QUIRKS:
        await this.executeCertQuirks(node.data as CertQuirksNodeData);
        break;

      case ScenarioNodeType.CONFIG_SET:
        await this.executeConfigSet(node.data as ConfigSetNodeData);
        break;

      case ScenarioNodeType.DATA_TRANSFER:
        await this.executeDataTransfer(node.data as DataTransferNodeData);
        break;

      case ScenarioNodeType.OCPP_CALL:
        await this.executeOcppCall(node.data as OcppCallNodeData, flow);
        break;

      case ScenarioNodeType.CALL_RESPONSE:
        await this.executeCallResponse(node.data as CallResponseNodeData, flow);
        break;

      case ScenarioNodeType.USE_BEHAVIOR:
        this.executeUseBehavior(node.id, node.data as UseBehaviorNodeData);
        break;

      case ScenarioNodeType.NOTIFY:
        this.executeNotify(node.data as NotifyNodeData, flow);
        break;

      case ScenarioNodeType.SWITCH:
        this.executeSwitch(node.data as SwitchNodeData, flow);
        break;

      case ScenarioNodeType.CHOICE:
        this.executeChoice(node.data as ChoiceNodeData, flow);
        break;

      case ScenarioNodeType.SET_STATE:
        this.executeSetState(node.data as SetStateNodeData, flow);
        break;

      case ScenarioNodeType.CONNECTION_TRIGGER:
        await this.executeConnectionTrigger(
          node.id,
          node.data as ConnectionTriggerNodeData,
          flow,
        );
        break;

      // Schema 1.9: control flow only; the walk forks and meets.
      case ScenarioFlowNodeType.PARALLEL:
      case ScenarioFlowNodeType.JOIN:
        break;

      default:
        console.warn(`Unknown node type: ${node.type}`);
    }
  }

  /** Send a StatusNotification.req with the user-supplied payload. */
  private async executeStatusNotification(
    data: StatusNotificationNodeData,
  ): Promise<void> {
    // ScenarioRuntime resolves the bound connectorId for the runtime. When
    // the node specifies an explicit connectorId we use that (e.g. 0 to
    // target the CP main controller); otherwise the runtime fills in the
    // scenario's bound connector.
    if (!this.callbacks.onSendStatusNotification) return;
    const targetConnectorId = data.connectorId ?? -1;
    this.callbacks.onSendStatusNotification(targetConnectorId, data.status, {
      errorCode: data.errorCode,
      info: data.info,
      vendorErrorCode: data.vendorErrorCode,
      vendorId: data.vendorId,
    });
    this.callbacks.log?.(
      `StatusNotification connector=${targetConnectorId} status=${data.status}${
        data.errorCode ? ` errorCode=${data.errorCode}` : ""
      }`,
      "info",
    );
  }

  /** Pre-arm the connector's next UnlockConnector.req response. */
  private async executeUnlockOutcome(
    data: UnlockOutcomeNodeData,
  ): Promise<void> {
    if (!this.callbacks.onSetUnlockOutcome) {
      this.callbacks.log?.(
        "UnlockOutcome: no onSetUnlockOutcome callback wired",
        "warn",
      );
      return;
    }
    this.callbacks.onSetUnlockOutcome(data.outcome);
    this.callbacks.log?.(`Connector unlockResponse → ${data.outcome}`, "info");
  }

  /** Issue #110: pre-arm a one-shot `{ status }` response override. */
  private async executeResponseOverride(
    data: ResponseOverrideNodeData,
  ): Promise<void> {
    if (!this.callbacks.onArmResponseOverride) {
      this.callbacks.log?.(
        "ResponseOverride: no onArmResponseOverride callback wired",
        "warn",
      );
      return;
    }
    this.callbacks.onArmResponseOverride(data.action, data.status);
    // Issue #110: track this action so we can clear it when the run ends.
    if (!this.armedOverrideActions.includes(data.action)) {
      this.armedOverrideActions.push(data.action);
    }
    this.callbacks.log?.(
      `Armed response override: ${data.action} → ${data.status}`,
      "info",
    );
  }

  /** Issue #247: set or clear an inbound call policy. */
  private async executeInboundPolicy(
    data: InboundPolicyNodeData,
  ): Promise<void> {
    if (data.policy === "answer") {
      // Clear the policy for this action.
      if (!this.callbacks.onClearInboundPolicy) {
        this.callbacks.log?.(
          "InboundPolicy: no onClearInboundPolicy callback wired",
          "warn",
        );
        return;
      }
      this.callbacks.onClearInboundPolicy(data.action);
      this.callbacks.log?.(`Cleared inbound policy: ${data.action}`, "info");
    } else if (data.policy === "callerror" || data.policy === "ignore") {
      // Arm a new policy.
      if (!this.callbacks.onSetInboundPolicy) {
        this.callbacks.log?.(
          "InboundPolicy: no onSetInboundPolicy callback wired",
          "warn",
        );
        return;
      }
      this.callbacks.onSetInboundPolicy(
        data.action,
        data.policy,
        data.errorCode,
        data.errorDescription,
      );
      // Track this action so we can clear it when the run ends.
      if (!this.armedInboundPolicyActions.includes(data.action)) {
        this.armedInboundPolicyActions.push(data.action);
      }
      const policyDesc =
        data.policy === "callerror"
          ? `callerror(${data.errorCode ?? "NotImplemented"})`
          : "ignore";
      this.callbacks.log?.(
        `Armed inbound policy: ${data.action} → ${policyDesc}`,
        "info",
      );
    }
  }

  /** Issue #247 Phase 3: set or clear certificate quirks. */
  private async executeCertQuirks(data: CertQuirksNodeData): Promise<void> {
    if (data.mode === "clear") {
      // Clear all quirks.
      if (!this.callbacks.onClearCertificateQuirks) {
        this.callbacks.log?.(
          "CertQuirks: no onClearCertificateQuirks callback wired",
          "warn",
        );
        return;
      }
      this.callbacks.onClearCertificateQuirks();
      this.callbacks.log?.("Cleared certificate quirks", "info");
    } else if (data.mode === "set") {
      // Build quirks from preset (if any) + explicit overrides.
      const quirks: Record<string, unknown> = {};

      // Start with preset if specified
      if (data.preset === "octt") {
        quirks.csrKeyAlgorithm = "RSA";
        quirks.csrPemLineEndings = "crlf";
        quirks.requiredCertificateSignatureAlgorithms = ["RSASSA-PKCS1-v1_5"];
        quirks.hiddenConfigurationKeys = ["CpoName"];
      }

      // Apply explicit field overrides
      if (data.csrKeyAlgorithm !== undefined) {
        quirks.csrKeyAlgorithm = data.csrKeyAlgorithm;
      }
      if (data.csrPemLineEndings !== undefined) {
        quirks.csrPemLineEndings = data.csrPemLineEndings;
      }
      if (data.requiredCertificateSignatureAlgorithms !== undefined) {
        quirks.requiredCertificateSignatureAlgorithms =
          data.requiredCertificateSignatureAlgorithms;
      }
      if (data.hiddenConfigurationKeys !== undefined) {
        quirks.hiddenConfigurationKeys = data.hiddenConfigurationKeys;
      }

      if (!this.callbacks.onSetCertificateQuirks) {
        this.callbacks.log?.(
          "CertQuirks: no onSetCertificateQuirks callback wired",
          "warn",
        );
        return;
      }

      this.callbacks.onSetCertificateQuirks(
        quirks as Parameters<
          NonNullable<typeof this.callbacks.onSetCertificateQuirks>
        >[0],
      );
      this.armedCertificateQuirks = true;

      const presetDesc = data.preset ? ` (preset: ${data.preset})` : "";
      this.callbacks.log?.(
        `Armed certificate quirks${presetDesc}: ${JSON.stringify(quirks)}`,
        "info",
      );
    }
  }

  /** Apply a ChangeConfiguration locally via the ConfigurationStore. */
  private async executeConfigSet(data: ConfigSetNodeData): Promise<void> {
    if (!this.callbacks.onConfigSet) {
      this.callbacks.log?.("ConfigSet: no onConfigSet callback wired", "warn");
      return;
    }
    this.callbacks.onConfigSet(data.key, data.value);
    this.callbacks.log?.(`ConfigSet ${data.key}='${data.value}'`, "info");
  }

  /** Send a CP-initiated DataTransfer.req with the user's vendor/message id. */
  private async executeDataTransfer(data: DataTransferNodeData): Promise<void> {
    if (!this.callbacks.onSendDataTransfer) {
      this.callbacks.log?.(
        "DataTransfer: no onSendDataTransfer callback wired",
        "warn",
      );
      return;
    }
    this.callbacks.onSendDataTransfer(data.vendorId, data.messageId, data.data);
    this.callbacks.log?.(`DataTransfer vendorId=${data.vendorId}`, "info");
  }

  /** Send an expert OCPP call (#389) and log the answer. A CALLERROR is an
   *  answer — often the one the scenario is after — so the flow goes on; a
   *  refusal or no answer throws and fails the run. */
  private async executeOcppCall(
    data: OcppCallNodeData,
    flow: Flow,
  ): Promise<void> {
    if (!this.callbacks.onSendOcppCall) {
      this.callbacks.log?.(
        "OCPP call: no onSendOcppCall callback wired",
        "warn",
      );
      return;
    }
    const { action, skipValidation, applyResponse } = data;
    const payload = resolveFrom(
      data.payload,
      this.fromScope(flow),
      `ocppCall(${action})`,
    ) as Record<string, unknown>;
    const call = this.callbacks.onSendOcppCall({
      action,
      payload,
      skipValidation,
      applyResponse,
    });
    // stop() must not wait up to 25 s for the answer. Once stopped, the call's
    // fate is no longer this run's: a later rejection is swallowed rather than
    // reported as a run error after `execution.stopped`.
    const outcome = await Promise.race([
      call,
      flow.scope.ended.then(() => null),
    ]);
    if (outcome === null) {
      call.catch(() => undefined);
      return;
    }
    flow.response =
      outcome.kind === "callResult"
        ? {
            kind: "result",
            action,
            messageId: outcome.messageId,
            payload: outcome.payload,
          }
        : {
            kind: "error",
            action,
            messageId: outcome.messageId,
            errorCode: outcome.errorCode,
            errorDescription: outcome.errorDescription,
            errorDetails: outcome.errorDetails,
          };
    if (outcome.kind === "callResult") {
      this.callbacks.log?.(
        `OCPP call ${data.action} → CALLRESULT ${JSON.stringify(outcome.payload)}`,
        "info",
      );
    } else {
      this.callbacks.log?.(
        `OCPP call ${data.action} → CALLERROR ${outcome.errorCode}: ${outcome.errorDescription}`,
        "warn",
      );
    }
  }

  /**
   * Execute status change node
   */
  private async executeStatusChange(data: StatusChangeNodeData): Promise<void> {
    if (this.callbacks.onStatusChange) {
      await this.callbacks.onStatusChange(data.status);
    }
  }

  /**
   * Execute transaction node
   */
  private async executeTransaction(data: TransactionNodeData): Promise<void> {
    if (data.action === "start") {
      if (this.callbacks.onStartTransaction) {
        // Use the tagId captured from a preceding RemoteStartTrigger node if available
        // Precedence: a tag captured from a preceding RemoteStartTrigger, then
        // the node's own literal, then the charge point's pool (#299), then
        // the historical default so a charge point without a pool is
        // unchanged.
        const tagId =
          this.remoteStartTagId ||
          data.tagId ||
          this.callbacks.onResolveIdTag?.() ||
          DEFAULT_ID_TAG;
        // #599: the node's own idTokenType rides in the options; without
        // one the callback is called exactly as before.
        const options: StartTransactionOptions | null = data.idTokenType
          ? { ...this.remoteStartOptions, idTokenType: data.idTokenType }
          : this.remoteStartOptions;
        this.remoteStartTagId = null;
        this.remoteStartOptions = null;
        const outcome = options
          ? await this.callbacks.onStartTransaction(
              tagId,
              data.batteryCapacityKwh,
              data.initialSoc,
              options,
            )
          : await this.callbacks.onStartTransaction(
              tagId,
              data.batteryCapacityKwh,
              data.initialSoc,
            );
        // Issue #181: a denied local-authorize gate is a LOGGED SKIP, not
        // an error — the scenario continues to its next node (e.g. plugout
        // / end) exactly like TC_023's Authorize-Invalid/Expired/Blocked
        // graphs expect. `outcome` is `void` for callback implementations
        // that don't report one, so only act on it when present.
        if (outcome && outcome.started === false) {
          this.callbacks.log?.(
            `Transaction start denied (${outcome.denialStatus ?? "refused"}); continuing scenario`,
            "warn",
          );
        }
      }
    } else if (data.action === "stop") {
      if (this.callbacks.onStopTransaction) {
        const reason = this.remoteStopReason ?? data.stopReason ?? undefined;
        const options = this.remoteStopOptions;
        this.remoteStopReason = null;
        this.remoteStopOptions = null;
        if (options) {
          await this.callbacks.onStopTransaction(reason, options);
        } else {
          await this.callbacks.onStopTransaction(reason);
        }
      }
    }
  }

  /**
   * Execute meter value node with auto-increment support
   */
  private async executeMeterValue(
    nodeId: string,
    data: MeterValueNodeData,
    scope: BranchScope,
  ): Promise<void> {
    const meterCallbacks = this.callbacks as MeterValueCallbacks;
    const currentBeforeSeed = this.callbacks.onGetMeterValue?.();
    let seededValue = currentBeforeSeed ?? data.value;
    if (this.callbacks.onSetMeterValue) {
      // Daemon-restart resume case: the persisted connector_runtime row
      // restored a non-zero meter accumulator (e.g. 624 Wh from a charge
      // that was interrupted), and now the scenario walks back into the
      // meterValue node whose `data.value` is the node's *initial seed*
      // (commonly 0). Writing that seed would erase the accumulator and
      // restart the maxValue cap from scratch. Skip the seed write when
      // the connector already holds more.
      if (currentBeforeSeed == null || currentBeforeSeed <= data.value) {
        this.callbacks.onSetMeterValue(data.value);
        seededValue = data.value;
      } else {
        seededValue = currentBeforeSeed;
        this.callbacks.log?.(
          `[${this.scenario.name}] Preserving meter accumulator ${currentBeforeSeed}Wh (> node seed ${data.value}Wh) on resume`,
          "info",
        );
      }
    }

    // Handle auto-increment mode - start AutoMeterValue manager
    if (data.autoIncrement && this.callbacks.onStartAutoMeterValue) {
      // Resolve the stop conditions. Default is "manual" for back-compat,
      // which reads the node's maxTime / maxValue. "evSettings" derives a
      // maxValue from the connector's EV settings (capacity × ΔSoC).
      let resolvedMaxTime: number | undefined = data.maxTime;
      let resolvedMaxValue: number | undefined =
        data.maxValue ??
        (data.maxChargeKwh != null
          ? Math.round(data.maxChargeKwh * 1000)
          : undefined);

      if (data.stopMode === "evSettings") {
        const settings = this.callbacks.onGetEVSettings?.() ?? null;
        if (settings && settings.batteryCapacityKwh > 0) {
          const delta = Math.max(
            0,
            (settings.targetSoc ?? 0) - (settings.initialSoc ?? 0),
          );
          if (delta <= 0) {
            this.callbacks.log?.(
              `[${this.scenario.name}] stopMode=evSettings target already reached; auto-meter completes without starting`,
              "info",
            );
            return;
          }
          // Wh delivered to move from initialSoc% to targetSoc% on a
          // capacity-kWh battery: capacity_kWh × (Δ%/100) × 1000 Wh/kWh
          resolvedMaxValue = Math.round(
            settings.batteryCapacityKwh * delta * 10,
          );
          resolvedMaxTime = undefined; // EV-driven runs are value-bounded only
          this.callbacks.log?.(
            `[${this.scenario.name}] stopMode=evSettings → maxValue=${resolvedMaxValue}Wh ` +
              `(capacity=${settings.batteryCapacityKwh}kWh, ` +
              `${settings.initialSoc ?? 0}% → ${settings.targetSoc ?? 0}%)`,
            "info",
          );
        } else {
          this.callbacks.log?.(
            `[${this.scenario.name}] stopMode=evSettings but EV settings unavailable; auto-meter will run unbounded`,
            "warn",
          );
          resolvedMaxValue = undefined;
          resolvedMaxTime = undefined;
        }
      } else {
        this.callbacks.log?.(
          `[${this.scenario.name}] Starting AutoMeterValue: interval=${data.incrementInterval || 10}s increment=${data.incrementAmount || 1000}Wh maxTime=${resolvedMaxTime || "unlimited"} maxValue=${resolvedMaxValue || "unlimited"}`,
          "info",
        );
      }

      const meterStart =
        meterCallbacks.onGetTransactionMeterStart?.() ?? seededValue;
      const resolvedMaxMeterValue =
        resolvedMaxValue && resolvedMaxValue > 0
          ? meterStart + resolvedMaxValue
          : undefined;
      const autoMeterConfig: AutoMeterStartConfig = {
        intervalSeconds: data.incrementInterval || 10,
        incrementValue: data.incrementAmount || 1000,
        maxTimeSeconds: resolvedMaxTime,
        maxValue: resolvedMaxMeterValue,
        sendMessage: data.sendMessage,
      };

      this.callbacks.onStartAutoMeterValue(autoMeterConfig);

      if (resolvedMaxMeterValue && resolvedMaxMeterValue > 0) {
        try {
          await this.waitWithOptionalForceSkip(
            this.callbacks.onWaitForMeterValue?.(
              resolvedMaxMeterValue,
              resolvedMaxTime,
            ) ??
              (resolvedMaxTime && resolvedMaxTime > 0
                ? this.sleep(resolvedMaxTime * 1000, scope)
                : Promise.resolve()),
            scope,
          );
        } catch (error) {
          if (!resolvedMaxTime || !isMeterValueTimeout(error)) {
            throw error;
          }
        }
        this.callbacks.onStopAutoMeterValue?.();
      } else if (resolvedMaxTime && resolvedMaxTime > 0) {
        await this.waitWithProgress(nodeId, resolvedMaxTime, scope);
        this.callbacks.onStopAutoMeterValue?.();
      }
    }

    if (
      !data.autoIncrement &&
      data.sendMessage &&
      this.callbacks.onSendMeterValue
    ) {
      await this.callbacks.onSendMeterValue();
    }
  }

  /**
   * Execute delay node with progress updates
   */
  private async executeDelay(
    nodeId: string,
    data: DelayNodeData,
    scope: BranchScope,
  ): Promise<void> {
    let seconds = data.delaySeconds;
    if (data.until !== undefined) {
      // Schema 1.6 (#654): not before an instant on the station's clock.
      const at =
        typeof data.until === "string"
          ? new Date(data.until).getTime()
          : Number.NaN;
      if (Number.isNaN(at)) {
        throw new Error(
          `delay: until must be an ISO-8601 date-time, got ${JSON.stringify(data.until)}`,
        );
      }
      seconds = Math.max(seconds, (at - this.clock.now()) / 1000);
    }
    if (data.jitterSeconds !== undefined) {
      const jitter = data.jitterSeconds;
      if (
        typeof jitter !== "number" ||
        !Number.isFinite(jitter) ||
        jitter < 0
      ) {
        throw new Error(
          `delay: jitterSeconds must be a number of at least 0, got ${JSON.stringify(jitter)}`,
        );
      }
      // Whole milliseconds from the scenario's seeded stream, so one seed
      // gives one wait. A jitter of 0 draws nothing.
      if (jitter > 0) {
        seconds += this.rng.int(0, Math.round(jitter * 1000) + 1) / 1000;
      }
    }
    await this.waitWithProgress(nodeId, seconds, scope);
  }

  private async waitWithProgress(
    nodeId: string,
    totalSeconds: number,
    scope: BranchScope,
  ): Promise<void> {
    if (this.callbacks.onDelay) {
      await this.waitWithOptionalForceSkip(
        this.callbacks.onDelay(totalSeconds),
        scope,
      );
      return;
    }

    const updateInterval = 100; // Update progress every 100ms
    let elapsed = 0;

    const progressInterval = this.clock.setInterval(() => {
      elapsed += updateInterval / 1000;
      const remaining = Math.max(0, totalSeconds - elapsed);

      if (this.callbacks.onNodeProgress) {
        this.callbacks.onNodeProgress(nodeId, remaining, totalSeconds);
      }

      // Emit node progress events
      const progressData = {
        scenarioId: this.scenario.id,
        nodeId,
        remaining,
        total: totalSeconds,
      };
      this.eventEmitter?.emit("nodeProgress", progressData); // Backward compatibility
      this.eventEmitter?.emit("node.progress", progressData); // Hierarchical event

      if (remaining <= 0) {
        this.clock.clearInterval(progressInterval);
      }
    }, updateInterval);

    try {
      await this.waitWithOptionalForceSkip(
        this.sleep(totalSeconds * 1000, scope),
        scope,
      );
    } finally {
      this.clock.clearInterval(progressInterval);

      // Final progress update
      if (this.callbacks.onNodeProgress) {
        this.callbacks.onNodeProgress(nodeId, 0, totalSeconds);
      }

      // Emit final progress events
      const finalProgressData = {
        scenarioId: this.scenario.id,
        nodeId,
        remaining: 0,
        total: totalSeconds,
      };
      this.eventEmitter?.emit("nodeProgress", finalProgressData); // Backward compatibility
      this.eventEmitter?.emit("node.progress", finalProgressData); // Hierarchical event
    }
  }

  /**
   * Execute notification node
   */
  private async executeNotification(data: NotificationNodeData): Promise<void> {
    if (this.callbacks.onSendNotification) {
      await this.callbacks.onSendNotification(data.messageType, data.payload);
    }
  }

  /**
   * Execute connector plug node
   */
  private async executeConnectorPlug(
    data: ConnectorPlugNodeData,
  ): Promise<void> {
    if (this.callbacks.onConnectorPlug) {
      await this.callbacks.onConnectorPlug(data.action);
    }
  }

  /**
   * Execute remote start trigger node with progress updates
   * Waits for RemoteStartTransaction request from central system
   * Captures the tagId for use by subsequent Transaction nodes
   */
  private async executeRemoteStartTrigger(
    nodeId: string,
    data: RemoteStartTriggerNodeData,
    flow: Flow,
  ): Promise<void> {
    const waitForRemoteStart = this.callbacks.onWaitForRemoteStart;
    if (!waitForRemoteStart) return;

    const answer = (
      await this.runTriggerWait(
        nodeId,
        flow,
        data.timeout,
        (seconds) => `Timeout waiting for remote start (${seconds}s)`,
        () => waitForRemoteStart(),
      )
    )?.value;
    // A cancelled branch (schema 1.9) leaves the run's capture alone.
    if (flow.scope.cancelled) return;
    // A wait continued past (#240) captures nothing, so the next Transaction
    // node falls back to its own tag.
    if (answer === undefined) {
      this.remoteStartTagId = null;
      this.remoteStartOptions = null;
    } else if (typeof answer === "string") {
      this.remoteStartTagId = answer;
      this.remoteStartOptions = { triggerReason: "RemoteStart" };
    } else {
      this.remoteStartTagId = answer.tagId;
      this.remoteStartOptions = {
        triggerReason: "RemoteStart",
        ...(answer.remoteStartId !== undefined
          ? { remoteStartId: answer.remoteStartId }
          : {}),
        // The type the CSMS sent; a Transaction node's own idTokenType wins
        // (executeTransaction spreads the node's value last).
        ...(answer.idTokenType !== undefined
          ? { idTokenType: answer.idTokenType }
          : {}),
      };
    }
  }

  /**
   * Execute remote stop trigger node. Mirror of executeRemoteStartTrigger
   * but for the CSMS-initiated stop side. Parks the scenario until the
   * runtime callback resolves (the runtime installs a scenario-stop
   * handler on the CP so the default RemoteStopTransactionHandler defers
   * to us).
   */
  private async executeRemoteStopTrigger(
    nodeId: string,
    data: RemoteStopTriggerNodeData,
    flow: Flow,
  ): Promise<void> {
    const waitForRemoteStop = this.callbacks.onWaitForRemoteStop;
    if (!waitForRemoteStop) return;

    // Capture {reason, triggerReason} so the next Transaction Stop node can
    // pass `reason` through to StopTransaction.req. The runtime hard-codes
    // "Remote" for the CSMS path (§6.21). A continued wait (#240) captures
    // nothing, so that node falls back to its own stopReason.
    const result = await this.runTriggerWait(
      nodeId,
      flow,
      data.timeout,
      (seconds) => `Timeout waiting for remote stop (${seconds}s)`,
      () => waitForRemoteStop(),
    );
    if (flow.scope.cancelled) return;
    this.remoteStopReason = result?.value?.reason ?? null;
    this.remoteStopOptions = result
      ? { triggerReason: result.value?.triggerReason ?? "RemoteStop" }
      : null;
  }

  /**
   * Execute status trigger node with progress updates
   * Waits for connector status to change to target status
   */
  private async executeStatusTrigger(
    nodeId: string,
    data: StatusTriggerNodeData,
    flow: Flow,
  ): Promise<void> {
    const waitForStatus = this.callbacks.onWaitForStatus;
    if (!waitForStatus) return;

    await this.runTriggerWait(
      nodeId,
      flow,
      data.timeout,
      (seconds) =>
        `Timeout waiting for status: ${data.targetStatus} (${seconds}s)`,
      () => waitForStatus(data.targetStatus),
    );
  }

  /**
   * Execute reserve now node
   */
  private async executeReserveNow(data: ReserveNowNodeData): Promise<void> {
    if (!this.callbacks.onReserveNow) return;

    // Generate reservation ID if not provided
    const reservationId = data.reservationId || this.rng.int(0, 1000000);

    await this.callbacks.onReserveNow(
      data.expiryMinutes,
      data.idTag,
      data.parentIdTag,
      reservationId,
    );
  }

  /**
   * Execute cancel reservation node
   */
  private async executeCancelReservation(
    data: CancelReservationNodeData,
  ): Promise<void> {
    if (!this.callbacks.onCancelReservation) return;

    await this.callbacks.onCancelReservation(data.reservationId);
  }

  /**
   * Execute reservation trigger node (wait for ReserveNow request)
   */
  private async executeReservationTrigger(
    nodeId: string,
    data: ReservationTriggerNodeData,
    flow: Flow,
  ): Promise<void> {
    const waitForReservation = this.callbacks.onWaitForReservation;
    if (!waitForReservation) return;

    await this.runTriggerWait(
      nodeId,
      flow,
      data.timeout,
      (seconds) => `Timeout waiting for reservation (${seconds}s)`,
      () => waitForReservation(),
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
   * Wait if execution is paused
   */
  private async waitIfPaused(scope: BranchScope): Promise<void> {
    while (
      getScenarioStateName(this.service) === "paused" &&
      !scope.cancelled
    ) {
      await this.sleep(100, scope);
    }
  }

  /**
   * Wait for step command
   */
  private async waitForStep(scope: BranchScope): Promise<void> {
    const stateName = getScenarioStateName(this.service);
    if (stateName !== "stepping") return;

    if (this.pendingSteps > 0) {
      this.pendingSteps -= 1;
      this.service.send({ type: "STEP" });
      return;
    }

    let localResolve: (() => void) | null = null;
    const stepPromise = new Promise<void>((resolve) => {
      localResolve = () => resolve();
      this.stepResolve = localResolve;
    });

    try {
      await Promise.race([stepPromise, scope.ended]);
    } finally {
      if (this.stepResolve === localResolve) {
        this.stepResolve = null;
      }
    }
  }

  private async waitWithOptionalForceSkip(
    waitPromise: Promise<unknown>,
    scope: BranchScope,
  ): Promise<void> {
    const stateName = getScenarioStateName(this.service);
    if (stateName !== "stepping") {
      await Promise.race([waitPromise, scope.ended]);
      return;
    }

    let localResolve: (() => void) | null = null;
    const forcePromise = new Promise<void>((resolve) => {
      localResolve = resolve;
    });
    this.forceSkipResolve = localResolve;

    try {
      await Promise.race([waitPromise, forcePromise, scope.ended]);
    } finally {
      if (this.forceSkipResolve === localResolve) {
        this.forceSkipResolve = null;
      }
    }
  }

  /**
   * Notify state change
   */
  private notifyStateChange(): void {
    this.callbacks.onStateChange?.(this.getContext());
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number, scope: BranchScope): Promise<void> {
    if (this.aborted || scope.cancelled) {
      return Promise.resolve();
    }
    return Promise.race([
      new Promise<void>((resolve) => this.clock.setTimeout(resolve, ms)),
      scope.ended,
    ]);
  }

  /**
   * Park on a trigger wait (#240). The executor owns the node's timeout
   * through a {@link WaitControl} instead of the runtime, so an operator can
   * extend it, retry the wait (withdraw it and arm it again with the full
   * timeout) or continue past it without the awaited event. Resolves with
   * the awaited answer, or null when there is none (continued, force-skipped
   * or stopped). Timeout-bearing waits also surface 100ms remaining-time
   * progress events.
   *
   * When the timeout expires the run fails with the timeout error, unless
   * the node has a timeout edge (schema 1.8, `timeoutStep`): then the wait
   * resolves with null like a continued one (nothing is captured) and
   * `flow.timeoutTarget` sends the branch along that edge.
   */
  private async runTriggerWait<T>(
    nodeId: string,
    flow: Flow,
    timeoutSeconds: number | undefined,
    timeoutMessage: (seconds: number) => string,
    startWait: () => Promise<T>,
  ): Promise<{ value: T } | null> {
    const timeoutMs = Math.max(0, timeoutSeconds || 0) * 1000;
    const node = this.scenario.nodes.find((n) => n.id === nodeId);
    const expectation = node
      ? deriveExpectation(node, this.scenario.targetId)
      : null;
    const program = this.program();
    const programNode = program.nodesById.get(nodeId);
    const onTimeout = programNode ? timeoutStep(program, programNode) : null;

    for (;;) {
      const startedAt = this.clock.now();
      const control = new WaitControl(
        timeoutMs,
        (seconds) => new Error(timeoutMessage(seconds)),
        this.clock,
      );
      this.parkedWaits.push({ nodeId, control, expectation, startedAt });
      this.notifyStateChange();
      const stopProgress = this.reportWaitProgress(nodeId, control);
      let waitPromise: Promise<T> | undefined;
      // Only this attempt's own answer is returned: a withdrawn attempt that
      // answers late (e.g. with a stale RemoteStart tag) never reaches the run.
      let answer = null as { value: T } | null;
      let timeoutError: unknown = null;
      let outcome: WaitSignal | "settled" | "timedOut";
      try {
        waitPromise = startWait();
        outcome = await Promise.race([
          this.waitWithOptionalForceSkip(
            waitPromise.then((value) => {
              answer = { value };
            }),
            flow.scope,
          ).then(() => "settled" as const),
          // Without a timeout edge the expiry rejects and fails the run.
          onTimeout
            ? control.expired.catch((error: unknown) => {
                timeoutError = error;
                return "timedOut" as const;
              })
            : control.expired,
          control.signal,
        ]);
      } finally {
        if (waitPromise) cancelIfCancellable(waitPromise);
        control.dispose();
        stopProgress();
        this.unpark(control);
        this.notifyStateChange();
      }

      // A cancelled branch (schema 1.9) captures nothing.
      if (flow.scope.cancelled) return null;
      if (outcome === "settled") return answer;
      if (outcome === "timedOut" && onTimeout && !this.aborted) {
        const reason =
          timeoutError instanceof Error
            ? timeoutError.message
            : String(timeoutError);
        this.callbacks.log?.(
          `[${this.scenario.name}] ${reason}; "${
            node?.data?.label || nodeId
          }" goes on along its timeout edge to "${
            onTimeout.target.data?.label || onTimeout.target.id
          }"`,
          "info",
        );
        flow.timeoutTarget = onTimeout.target;
        return null;
      }
      if (outcome === "continue" || this.aborted) return null;
    }
  }

  /** Emit the 100ms remaining-time progress of a timeout-bearing wait;
   *  returns the function that stops it. */
  private reportWaitProgress(nodeId: string, control: WaitControl): () => void {
    if (control.deadlineAt === null) return () => {};

    const progressInterval = this.clock.setInterval(() => {
      const remaining = (control.remainingMs() ?? 0) / 1000;
      const total = control.totalSeconds;
      this.callbacks.onNodeProgress?.(nodeId, remaining, total);
      const progressData = {
        scenarioId: this.scenario.id,
        nodeId,
        remaining,
        total,
      };
      this.eventEmitter?.emit("nodeProgress", progressData); // Backward compatibility
      this.eventEmitter?.emit("node.progress", progressData); // Hierarchical event
      if (remaining <= 0) this.clock.clearInterval(progressInterval);
    }, 100);

    return () => {
      this.clock.clearInterval(progressInterval);
      const total = control.totalSeconds;
      this.callbacks.onNodeProgress?.(nodeId, 0, total);
      this.eventEmitter?.emit("nodeProgress", {
        scenarioId: this.scenario.id,
        nodeId,
        remaining: 0,
        total,
      });
    };
  }

  /**
   * Issue #110: park the scenario until the CSMS sends `data.action`.
   * Mirror of executeRemoteStopTrigger; the CP core handler still runs,
   * we only synchronize on arrival and log the payload.
   */
  private async executeCsmsCallTrigger(
    nodeId: string,
    data: CsmsCallTriggerNodeData,
    flow: Flow,
  ): Promise<void> {
    const waitForCsmsCall = this.callbacks.onWaitForCsmsCall;
    if (!waitForCsmsCall) return;
    if (
      data.payload !== undefined &&
      (typeof data.payload !== "object" ||
        data.payload === null ||
        Array.isArray(data.payload))
    ) {
      throw new Error(
        `csmsCallTrigger(${data.action}): payload condition must be a JSON object`,
      );
    }
    const replace = data.behavior === "replace";
    const result = await this.runTriggerWait(
      nodeId,
      flow,
      data.timeout,
      (seconds) =>
        `Timeout waiting for CSMS call ${data.action}${
          data.payload ? " matching payload" : ""
        } (${seconds}s)`,
      () =>
        waitForCsmsCall(
          data.action,
          data.payload,
          replace
            ? {
                scenarioId: this.scenario.id,
                nodeId,
                ...(data.onBusy ? { onBusy: data.onBusy } : {}),
              }
            : undefined,
        ),
    );
    if (result) {
      this.callbacks.log?.(
        `CSMS call received: ${result.value.action}`,
        "info",
      );
      if (replace) {
        if (!result.value.exchange) {
          throw new Error(
            `csmsCallTrigger(${data.action}): behavior "replace" is not available on this station`,
          );
        }
        // The branch owns the CALL from here on.
        flow.exchange = result.value.exchange;
        flow.answered = false;
      }
    }
  }

  /**
   * Schema 1.5 (#566): answer the CALL this branch took over and wait until
   * the answer settled on the wire. An answer that was not delivered (the
   * connection closed or changed, the frame was dropped) fails the run.
   */
  private async executeCallResponse(
    data: CallResponseNodeData,
    flow: Flow,
  ): Promise<void> {
    const exchange = flow.exchange;
    if (!exchange) {
      throw new Error(
        'callResponse: this branch holds no CALL; place it after a csmsCallTrigger with behavior "replace"',
      );
    }
    if (flow.answered) {
      throw new Error(
        `callResponse: the ${exchange.action} CALL of this branch is already answered`,
      );
    }
    if (
      (data.kind === "accepted" || data.kind === "rejected") &&
      (data.payload !== undefined || data.skipValidation)
    ) {
      throw new Error(
        `callResponse: kind "${data.kind}" is the ${exchange.action} answer of the station's OCPP version and takes no payload`,
      );
    }
    const payload =
      data.kind === "result"
        ? (resolveFrom(
            data.payload ?? {},
            this.fromScope(flow),
            `callResponse(${exchange.action})`,
          ) as Record<string, unknown>)
        : undefined;
    const settled = await Promise.race([
      exchange.answer({
        kind: data.kind,
        ...(payload === undefined ? {} : { payload }),
        ...(data.errorCode === undefined ? {} : { errorCode: data.errorCode }),
        ...(data.errorDescription === undefined
          ? {}
          : { errorDescription: data.errorDescription }),
        ...(data.skipValidation ? { skipValidation: true } : {}),
      }),
      flow.scope.ended.then(() => null),
    ]);
    if (settled === null) {
      // Cancelled mid-answer (schema 1.9): the answer is on its way, never
      // answer the CALL again.
      if (flow.scope.cancelled) flow.answered = true;
      return;
    }
    flow.answered = true;
    if (!settled.delivered) {
      throw new Error(
        `callResponse: the answer to ${exchange.action} was not delivered (${settled.reason})`,
      );
    }
    this.callbacks.log?.(
      `Answered ${exchange.action} with ${data.kind}`,
      "info",
    );
  }

  /** Schema 1.5 (#566): select a behavior loaded on the station. */
  private executeUseBehavior(nodeId: string, data: UseBehaviorNodeData): void {
    if (!this.callbacks.onUseBehavior) {
      throw new Error("useBehavior: this station cannot select behaviors");
    }
    const mode = data.mode ?? "use";
    if (mode !== "use" && mode !== "disable") {
      throw new Error(
        `useBehavior: mode must be "use" or "disable", got ${JSON.stringify(mode)}`,
      );
    }
    const params = data.params;
    if (params !== undefined) {
      const bad = jsonProblem(params, "params");
      if (bad || typeof params !== "object" || Array.isArray(params)) {
        throw new Error(
          `useBehavior ${data.behaviorId}: params must be a JSON object${bad ? ` (${bad})` : ""}`,
        );
      }
      if (mode === "disable" && Object.keys(params).length > 0) {
        throw new Error(
          `useBehavior ${data.behaviorId}: mode "disable" takes no params`,
        );
      }
    }
    this.callbacks.onUseBehavior(data.behaviorId, nodeId, {
      mode,
      ...(params === undefined ? {} : { params }),
    });
    this.callbacks.log?.(
      mode === "disable"
        ? `Disabling behavior ${data.behaviorId} for this run`
        : `Using behavior ${data.behaviorId}` +
            (params && Object.keys(params).length > 0
              ? ` with params ${JSON.stringify(params)}`
              : ""),
      "info",
    );
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

  /** Schema 1.6 (#654): `ctx.notify` as a node; does not wait for the CSMS. */
  private executeNotify(data: NotifyNodeData, flow: Flow): void {
    if (!this.callbacks.onNotify) {
      throw new Error("notify: this station cannot send notifications");
    }
    if (!(NOTIFY_KINDS as readonly string[]).includes(data.kind)) {
      throw new Error(
        `notify: kind must be one of ${NOTIFY_KINDS.join(", ")}, got ${JSON.stringify(data.kind)}`,
      );
    }
    const statuses: readonly string[] =
      data.kind === "logStatus"
        ? UPLOAD_LOG_STATUSES
        : data.kind === "diagnosticsStatus"
          ? DIAGNOSTICS_STATUSES
          : FIRMWARE_STATUSES;
    if (typeof data.status !== "string" || !statuses.includes(data.status)) {
      throw new Error(
        `notify: status for ${data.kind} must be one of ${statuses.join(", ")}, got ${JSON.stringify(data.status)}`,
      );
    }
    let requestId: number | undefined;
    if (data.requestId !== undefined) {
      const resolved = resolveFrom(
        data.requestId,
        this.fromScope(flow),
        `notify(${data.kind})`,
      );
      if (
        typeof resolved !== "number" ||
        !Number.isInteger(resolved) ||
        resolved < 0
      ) {
        throw new Error(
          `notify: requestId must be a whole number of at least 0, got ${JSON.stringify(resolved)}`,
        );
      }
      requestId = resolved;
    }
    if (data.kind === "signedFirmwareStatus" && requestId === undefined) {
      throw new Error("notify: signedFirmwareStatus needs a requestId");
    }
    this.callbacks.onNotify(data.kind, data.status, requestId);
    this.callbacks.log?.(
      `Notified ${data.kind} ${data.status}` +
        (requestId === undefined ? "" : ` (requestId ${requestId})`),
      "info",
    );
  }

  /** Schema 1.6 (#654): go on along `case-<n>` of the first equal case, else `default`. */
  private executeSwitch(data: SwitchNodeData, flow: Flow): void {
    if (!Array.isArray(data.cases)) {
      throw new Error("switch: cases must be an array");
    }
    data.cases.forEach((value, index) => {
      const bad = jsonProblem(value, `cases[${index}]`);
      if (bad || isFromReference(value)) {
        throw new Error(
          `switch: cases are JSON constants${bad ? ` (${bad})` : ', a "$from" is not allowed'}`,
        );
      }
      const problem = matcherProblem(value);
      if (problem) {
        throw new Error(`switch: cases[${index}]: ${problem.message}`);
      }
    });
    const scope = this.fromScope(flow);
    const value = resolveFromOrMissing(data.value, scope, "switch");
    const index = data.cases.findIndex((candidate) =>
      matchCase(value, candidate),
    );
    if (value === MISSING && index < 0) {
      // No `exists: false` case: fail as before, with the usual message.
      resolveFrom(data.value, scope, "switch");
    }
    flow.handle = index >= 0 ? `case-${index}` : "default";
    this.callbacks.log?.(
      `Switch on ${value === MISSING ? "(missing)" : JSON.stringify(value)} → ${flow.handle}`,
      "info",
    );
  }

  /** Schema 1.6 (#654): a seeded, weighted draw; go on along `option-<n>`. */
  private executeChoice(data: ChoiceNodeData, flow: Flow): void {
    const options = data.options;
    if (!Array.isArray(options) || options.length < 2) {
      throw new Error("choice: options must list at least two options");
    }
    const weights = options.map((option, index) => {
      const weight = option?.weight ?? 1;
      if (
        typeof weight !== "number" ||
        !Number.isFinite(weight) ||
        weight <= 0
      ) {
        throw new Error(
          `choice: options[${index}].weight must be a number above 0, got ${JSON.stringify(weight)}`,
        );
      }
      return weight;
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const draw = this.rng.next() * total;
    let acc = 0;
    let picked = weights.length - 1;
    for (let i = 0; i < weights.length; i += 1) {
      acc += weights[i]!;
      if (draw < acc) {
        picked = i;
        break;
      }
    }
    flow.handle = `option-${picked}`;
    this.callbacks.log?.(
      `Choice → ${flow.handle}${options[picked]?.label ? ` (${options[picked]!.label})` : ""}`,
      "info",
    );
  }

  /** Schema 1.6 (#654): store a JSON value in the state of this run. */
  private executeSetState(data: SetStateNodeData, flow: Flow): void {
    if (typeof data.key !== "string" || !STATE_KEY.test(data.key)) {
      throw new Error(
        `setState: key must be letters, digits and underscores, not starting with a digit, got ${JSON.stringify(data.key)}`,
      );
    }
    const value = resolveFrom(
      data.value,
      this.fromScope(flow),
      `setState(${data.key})`,
    );
    const bad = jsonProblem(value, "value");
    if (bad || value === undefined) {
      throw new Error(`setState: value must be JSON${bad ? ` (${bad})` : ""}`);
    }
    this.runState[data.key] = value;
    this.callbacks.log?.(
      `State ${data.key} = ${JSON.stringify(value)}`,
      "info",
    );
  }

  /** Issue #240: park until the WebSocket reaches data.event. */
  private async executeConnectionTrigger(
    nodeId: string,
    data: ConnectionTriggerNodeData,
    flow: Flow,
  ): Promise<void> {
    const waitForConnection = this.callbacks.onWaitForConnection;
    if (!waitForConnection) return;
    const result = await this.runTriggerWait(
      nodeId,
      flow,
      data.timeout,
      (seconds) => `Timeout waiting for ${data.event} (${seconds}s)`,
      () => waitForConnection(data.event),
    );
    if (result) this.callbacks.log?.(`Connection event: ${data.event}`, "info");
  }
}
