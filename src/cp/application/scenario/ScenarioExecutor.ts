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
  StatusTriggerNodeData,
  ReserveNowNodeData,
  CancelReservationNodeData,
  ReservationTriggerNodeData,
} from "./ScenarioTypes";
import {
  createScenarioMachine,
  getScenarioStateName,
  getScenarioContext,
} from "../state/machines/ScenarioStateMachine";
import { interpret } from "robot3";
import type { EventEmitter } from "../../shared/EventEmitter";

export class ScenarioExecutor {
  private scenario: ScenarioDefinition;
  private callbacks: ScenarioExecutorCallbacks;
  private service: ReturnType<typeof interpret>; // Robot3 service
  private stepResolve: ((value: void) => void) | null = null;
  private previousState: ScenarioExecutionState = "idle";
  private eventEmitter?: EventEmitter<ScenarioEvents>;

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
    this.service = interpret(machine, (machineState) => {
      const currentState = getScenarioStateName(
        machineState,
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
   * Start scenario execution
   */
  public async start(mode: ScenarioExecutionMode = "oneshot"): Promise<void> {
    // Dispatch START event to transition to running/stepping state
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

    try {
      await this.executeFlow();

      // Check if we were stopped during execution
      const stateName = getScenarioStateName(this.service.machine);
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
    }

    this.notifyStateChange();
  }

  /**
   * Execute the flow from start to end
   * Supports scenarios with internal loops - use Stop button to exit infinite loops
   * Supports parallel branches from Start node
   */
  private async executeFlow(): Promise<void> {
    // Find start node
    const startNode = this.scenario.nodes.find(
      (n) => n.type === ScenarioNodeType.START || n.data.label === "Start",
    );

    if (!startNode) {
      throw new Error("No start node found in scenario");
    }

    // Execute start node
    await this.executeSingleNode(startNode);

    // Check for parallel branches from Start node
    const outgoingEdges = this.scenario.edges.filter(
      (e) => e.source === startNode.id,
    );
    const nextNodes = outgoingEdges
      .map((edge) => this.scenario.nodes.find((n) => n.id === edge.target))
      .filter((node) => node !== undefined);

    if (nextNodes.length === 0) {
      this.callbacks.log?.(
        `[${this.scenario.name}] No nodes after Start, scenario ends`,
        "warn",
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
    this.service.machine.context.currentNodeId = null;
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
      getScenarioStateName(this.service.machine) !== "idle"
    ) {
      // Execute the current node
      await this.executeSingleNode(currentNode);

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
    // Update context with current node
    const context = getScenarioContext(this.service.machine);
    context.currentNodeId = node.id;
    context.executedNodes.push(node.id);

    // Update machine context manually (robot3 doesn't expose context mutation directly)
    this.service.machine.context.currentNodeId = node.id;
    this.service.machine.context.executedNodes = context.executedNodes;

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

    // Wait if paused
    await this.waitIfPaused();

    // Wait for step if in step mode
    const stateName = getScenarioStateName(this.service.machine);
    if (stateName === "stepping") {
      await this.waitForStep();
    }

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

      default:
        console.warn(`Unknown node type: ${node.type}`);
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
        await this.callbacks.onStartTransaction(
          data.tagId || "123456",
          data.batteryCapacityKwh,
          data.initialSoc,
        );
      }
    } else if (data.action === "stop") {
      if (this.callbacks.onStopTransaction) {
        await this.callbacks.onStopTransaction();
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
    if (this.callbacks.onSetMeterValue) {
      this.callbacks.onSetMeterValue(data.value);
    }

    // Handle auto-increment mode - start AutoMeterValue manager
    if (data.autoIncrement && this.callbacks.onStartAutoMeterValue) {
      this.callbacks.log?.(
        `[${this.scenario.name}] Starting AutoMeterValue: interval=${data.incrementInterval || 10}s increment=${data.incrementAmount || 1000}Wh maxTime=${data.maxTime || "unlimited"} maxValue=${data.maxValue || "unlimited"}`,
        "info",
      );

      this.callbacks.onStartAutoMeterValue({
        intervalSeconds: data.incrementInterval || 10,
        incrementValue: data.incrementAmount || 1000,
        maxTimeSeconds: data.maxTime,
        maxValue: data.maxValue,
      });
    }

    if (data.sendMessage && this.callbacks.onSendMeterValue) {
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
    if (this.callbacks.onDelay) {
      await this.callbacks.onDelay(data.delaySeconds);
    } else {
      const totalSeconds = data.delaySeconds;
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

      await this.sleep(totalSeconds * 1000);
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
   */
  private async executeRemoteStartTrigger(
    nodeId: string,
    data: RemoteStartTriggerNodeData,
  ): Promise<void> {
    if (!this.callbacks.onWaitForRemoteStart) return;

    const timeout = data.timeout || 0;

    // If no timeout, just wait without progress
    if (!timeout || timeout === 0) {
      await this.callbacks.onWaitForRemoteStart(timeout);
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
      await this.callbacks.onWaitForRemoteStart(timeout);
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
      await this.callbacks.onWaitForStatus(data.targetStatus, timeout);
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
      await this.callbacks.onWaitForStatus(data.targetStatus, timeout);
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
      await this.callbacks.onWaitForReservation(timeout);
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
      await this.callbacks.onWaitForReservation(timeout);
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
    const stateName = getScenarioStateName(this.service.machine);
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
    const stateName = getScenarioStateName(this.service.machine);
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
    const stateName = getScenarioStateName(this.service.machine);
    if (stateName === "stepping" && this.stepResolve) {
      this.service.send({ type: "STEP" });
      this.stepResolve();
      this.stepResolve = null;
    }
  }

  /**
   * Get current execution context
   */
  public getContext(): ScenarioExecutionContext {
    const stateName = getScenarioStateName(this.service.machine);
    const context = getScenarioContext(this.service.machine);

    return {
      scenarioId: context.scenarioId,
      state: stateName as ScenarioExecutionState,
      mode: context.mode,
      currentNodeId: context.currentNodeId,
      executedNodes: context.executedNodes,
      loopCount: context.loopCount,
      error: context.error,
    };
  }

  /**
   * Wait if execution is paused
   */
  private async waitIfPaused(): Promise<void> {
    while (getScenarioStateName(this.service.machine) === "paused") {
      await this.sleep(100);
    }
  }

  /**
   * Wait for step command
   */
  private async waitForStep(): Promise<void> {
    const stateName = getScenarioStateName(this.service.machine);
    if (stateName !== "stepping") return;

    return new Promise<void>((resolve) => {
      this.stepResolve = resolve;
    });
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
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
