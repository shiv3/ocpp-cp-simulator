import {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioExecutionState,
  ScenarioExecutionMode,
  ScenarioNodeType,
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
  ConfigSetNodeData,
  DataTransferNodeData,
  StartTransactionOptions,
  StopTransactionOptions,
} from "./ScenarioTypes";
import {
  createScenarioMachine,
  getScenarioStateName,
  getScenarioContext,
} from "../state/machines/ScenarioStateMachine";
import { interpret } from "robot3";
import type { EventEmitter } from "../../shared/EventEmitter";

type MaybeCancellablePromise<T> = Promise<T> & { cancel?: () => void };
type AutoMeterStartConfig = Parameters<
  NonNullable<ScenarioExecutorCallbacks["onStartAutoMeterValue"]>
>[0] & { sendMessage?: boolean };
type MeterValueCallbacks = ScenarioExecutorCallbacks & {
  onGetTransactionMeterStart?: () => number | null;
};

const cancelIfCancellable = (promise: Promise<unknown>): void => {
  (promise as MaybeCancellablePromise<unknown>).cancel?.();
};

const isMeterValueTimeout = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.startsWith("Timeout waiting for meter value:");

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
  private service: ReturnType<typeof interpret>; // Robot3 service
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
  private remoteStartTagId: string | null = null;
  private remoteStartOptions: StartTransactionOptions | null = null;
  // Reason captured from the most recent RemoteStopTrigger node, forwarded
  // to the next Transaction Stop's StopTransaction.req so the CSMS sees
  // "Remote" (§6.21) for RemoteStop-driven stops instead of a blank
  // reason. Cleared as soon as the stop node consumes it.
  private remoteStopReason: string | null = null;
  private remoteStopOptions: StopTransactionOptions | null = null;
  private currentNodeId: string | null = null;
  private executedNodes: string[] = [];
  // Issue #110: track which response overrides were armed during this run,
  // so they can be cleared when the run ends (both normal completion and stop()).
  private armedOverrideActions: string[] = [];

  constructor(
    scenario: ScenarioDefinition,
    callbacks: ScenarioExecutorCallbacks,
    eventEmitter?: EventEmitter<ScenarioEvents>,
  ) {
    this.scenario = scenario;
    this.callbacks = callbacks;
    this.eventEmitter = eventEmitter;

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
    this.executedNodes = [];
    this.stepResolve = null;
    this.pendingSteps = 0;
    this.armedOverrideActions = [];
    this.abortPromise = new Promise<void>((resolve) => {
      this.abortResolve = resolve;
    });
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

    if (resumeFromNodeId) {
      originNode = this.scenario.nodes.find((n) => n.id === resumeFromNodeId);
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
      originNode = this.scenario.nodes.find(
        (n) => n.type === ScenarioNodeType.START || n.data.label === "Start",
      );
      if (!originNode) {
        throw new Error("No start node found in scenario");
      }
      await this.executeSingleNode(originNode);
    }

    // Walk outgoing edges from the origin node (whether Start or resume).
    const outgoingEdges = this.scenario.edges.filter(
      (e) => e.source === originNode!.id,
    );
    const nextNodes = outgoingEdges
      .map((edge) => this.scenario.nodes.find((n) => n.id === edge.target))
      .filter((node): node is ScenarioNode => node !== undefined);

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
      await this.executeSequentialFlow(nextNodes[0]!);
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
      return this.executeSequentialFlow(node);
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
  private async executeSequentialFlow(startNode: ScenarioNode): Promise<void> {
    let currentNode = startNode;

    while (
      currentNode &&
      !this.aborted &&
      getScenarioStateName(this.service) !== "idle"
    ) {
      // Execute the current node
      await this.executeSingleNode(currentNode);

      // If the node finished while paused, do not make the next node visible
      // until the run has been resumed. Stop/abort can also land while parked.
      await this.waitIfPaused();
      if (this.aborted || getScenarioStateName(this.service) === "idle") {
        break;
      }

      // Check if this is the end node
      if (
        currentNode.type === ScenarioNodeType.END ||
        currentNode.data.label === "End"
      ) {
        break;
      }

      // Find next node
      const outgoingEdges = this.scenario.edges.filter(
        (e) => e.source === currentNode!.id,
      );
      if (outgoingEdges.length === 0) {
        break; // No more nodes to execute
      }

      // Find the first edge that points to an existing node
      let nextNode = null;
      for (const edge of outgoingEdges) {
        const candidate = this.scenario.nodes.find((n) => n.id === edge.target);
        if (candidate) {
          nextNode = candidate;
          break;
        }
      }

      if (!nextNode) {
        console.warn(
          `[ScenarioExecutor] All outgoing edges from node ${currentNode!.id} point to non-existent nodes. Branch will end here.`,
        );
        break;
      }

      currentNode = nextNode;
    }
  }

  /**
   * Execute a single node
   */
  private async executeSingleNode(node: ScenarioNode): Promise<void> {
    // A stop() may have landed while the previous node was awaiting; never
    // start another node once aborted.
    if (this.aborted) {
      return;
    }

    // Do not make the node visible while paused. This protects the boundary
    // after an in-flight wait resolves under pause.
    await this.waitIfPaused();
    if (this.aborted || getScenarioStateName(this.service) === "idle") {
      return;
    }

    // Wait for step before marking/emitting the node so each step exposes
    // exactly one more node.
    const stateName = getScenarioStateName(this.service);
    if (stateName === "stepping") {
      await this.waitForStep();
      if (this.aborted || getScenarioStateName(this.service) === "idle") {
        return;
      }
    }

    // Update context with current node
    this.currentNodeId = node.id;
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
      await this.executeNode(node);
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
  private async executeNode(node: ScenarioNode): Promise<void> {
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
        await this.executeMeterValue(node.id, node.data as MeterValueNodeData);
        break;

      case ScenarioNodeType.DELAY:
        await this.executeDelay(node.id, node.data as DelayNodeData);
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
        );
        break;

      case ScenarioNodeType.REMOTE_STOP_TRIGGER:
        await this.executeRemoteStopTrigger(
          node.id,
          node.data as RemoteStopTriggerNodeData,
        );
        break;

      case ScenarioNodeType.STATUS_TRIGGER:
        await this.executeStatusTrigger(
          node.id,
          node.data as StatusTriggerNodeData,
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
        );
        break;

      case ScenarioNodeType.CSMS_CALL_TRIGGER:
        await this.executeCsmsCallTrigger(
          node.id,
          node.data as CsmsCallTriggerNodeData,
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

      case ScenarioNodeType.CONFIG_SET:
        await this.executeConfigSet(node.data as ConfigSetNodeData);
        break;

      case ScenarioNodeType.DATA_TRANSFER:
        await this.executeDataTransfer(node.data as DataTransferNodeData);
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
        const tagId = this.remoteStartTagId || data.tagId || "123456";
        const options = this.remoteStartOptions;
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
                ? this.sleep(resolvedMaxTime * 1000)
                : Promise.resolve()),
          );
        } catch (error) {
          if (!resolvedMaxTime || !isMeterValueTimeout(error)) {
            throw error;
          }
        }
        this.callbacks.onStopAutoMeterValue?.();
      } else if (resolvedMaxTime && resolvedMaxTime > 0) {
        await this.waitWithProgress(nodeId, resolvedMaxTime);
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
  ): Promise<void> {
    await this.waitWithProgress(nodeId, data.delaySeconds);
  }

  private async waitWithProgress(
    nodeId: string,
    totalSeconds: number,
  ): Promise<void> {
    if (this.callbacks.onDelay) {
      await this.waitWithOptionalForceSkip(
        this.callbacks.onDelay(totalSeconds),
      );
      return;
    }

    const updateInterval = 100; // Update progress every 100ms
    let elapsed = 0;

    const progressInterval = setInterval(() => {
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
        clearInterval(progressInterval);
      }
    }, updateInterval);

    try {
      await this.waitWithOptionalForceSkip(this.sleep(totalSeconds * 1000));
    } finally {
      clearInterval(progressInterval);

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
  ): Promise<void> {
    if (!this.callbacks.onWaitForRemoteStart) return;

    const timeout = data.timeout || 0;

    // Wrap the promise to capture the resolved tagId
    let resolvedTagId: string | null = null;
    let resolvedOptions: StartTransactionOptions | null = null;
    const captureTagId = (
      promise: ReturnType<
        NonNullable<ScenarioExecutorCallbacks["onWaitForRemoteStart"]>
      >,
    ): Promise<void> =>
      promise.then((result) => {
        if (typeof result === "string") {
          resolvedTagId = result;
          resolvedOptions = { triggerReason: "RemoteStart" };
          return;
        }
        resolvedTagId = result.tagId;
        resolvedOptions = {
          triggerReason: "RemoteStart",
          ...(result.remoteStartId !== undefined
            ? { remoteStartId: result.remoteStartId }
            : {}),
        };
      });

    // If no timeout, just wait without progress
    if (!timeout || timeout === 0) {
      const waitPromise = this.callbacks.onWaitForRemoteStart(timeout);
      try {
        await this.waitWithOptionalForceSkip(captureTagId(waitPromise));
        this.remoteStartTagId = resolvedTagId;
        this.remoteStartOptions = resolvedOptions;
      } finally {
        cancelIfCancellable(waitPromise);
      }
      return;
    }

    // Start timeout countdown with progress updates
    const startTime = Date.now();
    const timeoutMs = timeout * 1000;

    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, (timeoutMs - elapsed) / 1000);

      if (this.callbacks.onNodeProgress) {
        this.callbacks.onNodeProgress(nodeId, remaining, timeout);
      }

      // Emit node progress events
      const progressData = {
        scenarioId: this.scenario.id,
        nodeId,
        remaining,
        total: timeout,
      };
      this.eventEmitter?.emit("nodeProgress", progressData); // Backward compatibility
      this.eventEmitter?.emit("node.progress", progressData); // Hierarchical event

      if (remaining <= 0) {
        clearInterval(progressInterval);
      }
    }, 100);

    try {
      const waitPromise = this.callbacks.onWaitForRemoteStart(timeout);
      try {
        await this.waitWithOptionalForceSkip(captureTagId(waitPromise));
      } finally {
        cancelIfCancellable(waitPromise);
      }
      this.remoteStartTagId = resolvedTagId;
      this.remoteStartOptions = resolvedOptions;
    } finally {
      clearInterval(progressInterval);

      // Clear progress
      if (this.callbacks.onNodeProgress) {
        this.callbacks.onNodeProgress(nodeId, 0, timeout);
      }

      // Emit final progress event
      this.eventEmitter?.emit("nodeProgress", {
        scenarioId: this.scenario.id,
        nodeId,
        remaining: 0,
        total: timeout,
      });
    }
  }

  /**
   * Execute remote stop trigger node. Mirror of executeRemoteStartTrigger
   * but for the CSMS-initiated stop side. Parks the scenario until the
   * runtime callback resolves (the runtime installs a scenario-stop
   * handler on the CP so the default RemoteStopTransactionHandler defers
   * to us). Returns the transactionId from the request; we don't surface
   * it on the scenario yet but capture it for parity with the start node.
   */
  private async executeRemoteStopTrigger(
    nodeId: string,
    data: RemoteStopTriggerNodeData,
  ): Promise<void> {
    if (!this.callbacks.onWaitForRemoteStop) return;

    const timeout = data.timeout || 0;
    // Wrap the resolved {transactionId, reason} so the next Transaction
    // Stop node can pass `reason` through to StopTransaction.req. The
    // runtime hard-codes "Remote" for the CSMS path (§6.21); we keep
    // the wrapping here so it survives waitWithOptionalForceSkip.
    if (!timeout || timeout === 0) {
      const waitPromise = this.callbacks.onWaitForRemoteStop(timeout);
      try {
        await this.waitWithOptionalForceSkip(
          waitPromise.then((res) => {
            this.remoteStopReason = res?.reason ?? null;
            this.remoteStopOptions = {
              triggerReason: res?.triggerReason ?? "RemoteStop",
            };
          }),
        );
      } finally {
        cancelIfCancellable(waitPromise);
      }
      return;
    }

    const startTime = Date.now();
    const timeoutMs = timeout * 1000;
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, (timeoutMs - elapsed) / 1000);
      this.callbacks.onNodeProgress?.(nodeId, remaining, timeout);
      const progressData = {
        scenarioId: this.scenario.id,
        nodeId,
        remaining,
        total: timeout,
      };
      this.eventEmitter?.emit("nodeProgress", progressData);
      this.eventEmitter?.emit("node.progress", progressData);
      if (remaining <= 0) clearInterval(progressInterval);
    }, 100);

    try {
      const waitPromise = this.callbacks.onWaitForRemoteStop(timeout);
      try {
        await this.waitWithOptionalForceSkip(
          waitPromise.then((res) => {
            this.remoteStopReason = res?.reason ?? null;
            this.remoteStopOptions = {
              triggerReason: res?.triggerReason ?? "RemoteStop",
            };
          }),
        );
      } finally {
        cancelIfCancellable(waitPromise);
      }
    } finally {
      clearInterval(progressInterval);
      this.callbacks.onNodeProgress?.(nodeId, 0, timeout);
      this.eventEmitter?.emit("nodeProgress", {
        scenarioId: this.scenario.id,
        nodeId,
        remaining: 0,
        total: timeout,
      });
    }
  }

  /**
   * Execute status trigger node with progress updates
   * Waits for connector status to change to target status
   */
  private async executeStatusTrigger(
    nodeId: string,
    data: StatusTriggerNodeData,
  ): Promise<void> {
    if (!this.callbacks.onWaitForStatus) return;

    const timeout = data.timeout || 0;

    // If no timeout, just wait without progress
    if (!timeout || timeout === 0) {
      await this.waitWithOptionalForceSkip(
        this.callbacks.onWaitForStatus(data.targetStatus, timeout),
      );
      return;
    }

    // Start timeout countdown with progress updates
    const startTime = Date.now();
    const timeoutMs = timeout * 1000;

    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, (timeoutMs - elapsed) / 1000);

      if (this.callbacks.onNodeProgress) {
        this.callbacks.onNodeProgress(nodeId, remaining, timeout);
      }

      // Emit node progress events
      const progressData = {
        scenarioId: this.scenario.id,
        nodeId,
        remaining,
        total: timeout,
      };
      this.eventEmitter?.emit("nodeProgress", progressData); // Backward compatibility
      this.eventEmitter?.emit("node.progress", progressData); // Hierarchical event

      if (remaining <= 0) {
        clearInterval(progressInterval);
      }
    }, 100);

    try {
      await this.waitWithOptionalForceSkip(
        this.callbacks.onWaitForStatus(data.targetStatus, timeout),
      );
    } finally {
      clearInterval(progressInterval);

      // Clear progress
      if (this.callbacks.onNodeProgress) {
        this.callbacks.onNodeProgress(nodeId, 0, timeout);
      }

      // Emit final progress event
      this.eventEmitter?.emit("nodeProgress", {
        scenarioId: this.scenario.id,
        nodeId,
        remaining: 0,
        total: timeout,
      });
    }
  }

  /**
   * Execute reserve now node
   */
  private async executeReserveNow(data: ReserveNowNodeData): Promise<void> {
    if (!this.callbacks.onReserveNow) return;

    // Generate reservation ID if not provided
    const reservationId =
      data.reservationId || Math.floor(Math.random() * 1000000);

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
  ): Promise<void> {
    if (!this.callbacks.onWaitForReservation) return;

    const timeout = data.timeout || 0;

    // If no timeout, just wait without progress
    if (!timeout || timeout === 0) {
      await this.waitWithOptionalForceSkip(
        this.callbacks.onWaitForReservation(timeout),
      );
      return;
    }

    // Start timeout countdown with progress updates
    const startTime = Date.now();
    const timeoutMs = timeout * 1000;

    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, (timeoutMs - elapsed) / 1000);

      if (this.callbacks.onNodeProgress) {
        this.callbacks.onNodeProgress(nodeId, remaining, timeout);
      }

      // Emit node progress events
      const progressData = {
        scenarioId: this.scenario.id,
        nodeId,
        remaining,
        total: timeout,
      };
      this.eventEmitter?.emit("nodeProgress", progressData); // Backward compatibility
      this.eventEmitter?.emit("node.progress", progressData); // Hierarchical event

      if (remaining <= 0) {
        clearInterval(progressInterval);
      }
    }, 100);

    try {
      await this.waitWithOptionalForceSkip(
        this.callbacks.onWaitForReservation(timeout),
      );
    } finally {
      clearInterval(progressInterval);

      // Clear progress
      if (this.callbacks.onNodeProgress) {
        this.callbacks.onNodeProgress(nodeId, 0, timeout);
      }

      // Emit final progress event
      this.eventEmitter?.emit("nodeProgress", {
        scenarioId: this.scenario.id,
        nodeId,
        remaining: 0,
        total: timeout,
      });
    }
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

    return {
      scenarioId: context.scenarioId,
      state: stateName as ScenarioExecutionState,
      mode: context.mode,
      currentNodeId: this.currentNodeId,
      executedNodes: [...this.executedNodes],
      loopCount: context.loopCount,
      error: context.error,
    };
  }

  /**
   * Wait if execution is paused
   */
  private async waitIfPaused(): Promise<void> {
    while (getScenarioStateName(this.service) === "paused") {
      await this.sleep(100);
    }
  }

  /**
   * Wait for step command
   */
  private async waitForStep(): Promise<void> {
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
      await Promise.race([stepPromise, this.abortPromise]);
    } finally {
      if (this.stepResolve === localResolve) {
        this.stepResolve = null;
      }
    }
  }

  private async waitWithOptionalForceSkip(
    waitPromise: Promise<void>,
  ): Promise<void> {
    const stateName = getScenarioStateName(this.service);
    if (stateName !== "stepping") {
      await Promise.race([waitPromise, this.abortPromise]);
      return;
    }

    let localResolve: (() => void) | null = null;
    const forcePromise = new Promise<void>((resolve) => {
      localResolve = resolve;
    });
    this.forceSkipResolve = localResolve;

    try {
      await Promise.race([waitPromise, forcePromise, this.abortPromise]);
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
  private sleep(ms: number): Promise<void> {
    if (this.aborted) {
      return Promise.resolve();
    }
    return Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
      this.abortPromise,
    ]);
  }

  /**
   * Issue #110: park the scenario until the CSMS sends `data.action`.
   * Mirror of executeRemoteStopTrigger; the CP core handler still runs,
   * we only synchronize on arrival and log the payload.
   */
  private async executeCsmsCallTrigger(
    nodeId: string,
    data: CsmsCallTriggerNodeData,
  ): Promise<void> {
    if (!this.callbacks.onWaitForCsmsCall) return;

    const timeout = Math.max(0, data.timeout || 0);
    if (!timeout || timeout === 0) {
      const waitPromise = this.callbacks.onWaitForCsmsCall(
        data.action,
        timeout,
      );
      try {
        await this.waitWithOptionalForceSkip(
          waitPromise.then((res) => {
            this.callbacks.log?.(`CSMS call received: ${res.action}`, "info");
          }),
        );
      } finally {
        cancelIfCancellable(waitPromise);
      }
      return;
    }

    const startTime = Date.now();
    const timeoutMs = timeout * 1000;
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, (timeoutMs - elapsed) / 1000);
      this.callbacks.onNodeProgress?.(nodeId, remaining, timeout);
      const progressData = {
        scenarioId: this.scenario.id,
        nodeId,
        remaining,
        total: timeout,
      };
      this.eventEmitter?.emit("nodeProgress", progressData);
      this.eventEmitter?.emit("node.progress", progressData);
      if (remaining <= 0) clearInterval(progressInterval);
    }, 100);

    try {
      const waitPromise = this.callbacks.onWaitForCsmsCall(
        data.action,
        timeout,
      );
      try {
        await this.waitWithOptionalForceSkip(
          waitPromise.then((res) => {
            this.callbacks.log?.(`CSMS call received: ${res.action}`, "info");
          }),
        );
      } finally {
        cancelIfCancellable(waitPromise);
      }
    } finally {
      clearInterval(progressInterval);
      this.callbacks.onNodeProgress?.(nodeId, 0, timeout);
      this.eventEmitter?.emit("nodeProgress", {
        scenarioId: this.scenario.id,
        nodeId,
        remaining: 0,
        total: timeout,
      });
    }
  }
}
