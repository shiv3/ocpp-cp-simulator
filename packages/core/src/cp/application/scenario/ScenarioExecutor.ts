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
import { type FromScope } from "./resolveFrom";
import {
  createScenarioMachine,
  getScenarioStateName,
  getScenarioContext,
  type ScenarioMachineService,
} from "../state/machines/ScenarioStateMachine";
import { interpret } from "robot3";
import { BranchScope } from "./branchScope";
import type { WaitControl } from "./WaitControl";
import { type WaitSignal } from "./WaitControl";
import type { Flow, FlowRunContext, ParkedWait } from "./nodes/context";
import { executeFlow } from "./flow";
import { sleep, waitWithOptionalForceSkip, waitWithProgress } from "./waits";
import { ScenarioRunStateError } from "../../domain/errors/ScenarioRunStateError";
import type { EventEmitter } from "../../shared/EventEmitter";
import { realClock } from "../../shared/clock";
import type { SimClock } from "../../shared/clock";
import { systemRngStreams } from "../../shared/rng";
import type { Rng } from "../../shared/rng";
import {
  lowerScenario,
  type ScenarioProgram,
} from "../../../scenario/scenarioGraph";

type ScenarioEdge = ScenarioDefinition["edges"][number];

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
  private readonly nodeCtx: FlowRunContext;

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

  private createNodeContext(): FlowRunContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getters read the live fields
    const host = this;
    const ctx: FlowRunContext = {
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
      get rootScope() {
        return host.rootScope;
      },
      get currentNodeId() {
        return host.currentNodeId;
      },
      set currentNodeId(value) {
        host.currentNodeId = value;
      },
      get currentNodeStartedAt() {
        return host.currentNodeStartedAt;
      },
      set currentNodeStartedAt(value) {
        host.currentNodeStartedAt = value;
      },
      get executedNodes() {
        return host.executedNodes;
      },
      set executedNodes(value) {
        host.executedNodes = value;
      },
      sendNodeComplete: (nodeId) => {
        host.service.send({ type: "NODE_COMPLETE", nodeId });
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
      await executeFlow(this.nodeCtx, opts);

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
