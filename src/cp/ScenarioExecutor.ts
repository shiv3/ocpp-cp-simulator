import {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioExecutionState,
  ScenarioExecutionMode,
  ScenarioNodeType,
  ScenarioExecutorCallbacks,
  StatusChangeNodeData,
  TransactionNodeData,
  MeterValueNodeData,
  DelayNodeData,
  NotificationNodeData,
  ConnectorPlugNodeData,
} from "./types/ScenarioTypes";
import { Edge } from "@xyflow/react";

export class ScenarioExecutor {
  private scenario: ScenarioDefinition;
  private callbacks: ScenarioExecutorCallbacks;
  private context: ScenarioExecutionContext;
  private isPaused: boolean = false;
  private isStopped: boolean = false;
  private stepMode: boolean = false;
  private stepResolve: ((value: void) => void) | null = null;

  constructor(scenario: ScenarioDefinition, callbacks: ScenarioExecutorCallbacks) {
    this.scenario = scenario;
    this.callbacks = callbacks;
    this.context = {
      scenarioId: scenario.id,
      state: "idle",
      mode: "oneshot",
      currentNodeId: null,
      executedNodes: [],
      loopCount: 0,
    };
  }

  /**
   * Start scenario execution
   */
  public async start(mode: ScenarioExecutionMode = "oneshot"): Promise<void> {
    this.context.mode = mode;
    this.context.state = "running";
    this.context.executedNodes = [];
    this.context.loopCount = 0;
    this.isPaused = false;
    this.isStopped = false;
    this.stepMode = mode === "step";

    this.notifyStateChange();

    try {
      do {
        await this.executeFlow();
        this.context.loopCount++;

        if (this.context.mode !== "loop" || this.isStopped) {
          break;
        }

        // Reset for next loop
        this.context.executedNodes = [];
      } while (true);

      if (!this.isStopped) {
        this.context.state = "completed";
      }
    } catch (error) {
      this.context.state = "error";
      this.context.error = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }

    this.notifyStateChange();
  }

  /**
   * Execute the flow from start to end
   */
  private async executeFlow(): Promise<void> {
    // Find start node
    const startNode = this.scenario.nodes.find(
      (n) => n.type === ScenarioNodeType.START || n.data.label === "Start"
    );

    if (!startNode) {
      throw new Error("No start node found in scenario");
    }

    let currentNode = startNode;
    const visited = new Set<string>();

    while (currentNode && !this.isStopped) {
      // Check for infinite loop
      if (visited.has(currentNode.id)) {
        throw new Error(`Infinite loop detected at node ${currentNode.id}`);
      }
      visited.add(currentNode.id);

      this.context.currentNodeId = currentNode.id;
      this.context.executedNodes.push(currentNode.id);
      this.notifyStateChange();
      this.callbacks.onNodeExecute?.(currentNode.id);

      // Wait if paused
      await this.waitIfPaused();

      // Wait for step if in step mode
      if (this.stepMode) {
        await this.waitForStep();
      }

      // Execute node
      if (currentNode.type !== ScenarioNodeType.START && currentNode.type !== ScenarioNodeType.END) {
        await this.executeNode(currentNode);
      }

      // Check if this is the end node
      if (currentNode.type === ScenarioNodeType.END || currentNode.data.label === "End") {
        break;
      }

      // Find next node
      const nextEdge = this.scenario.edges.find((e) => e.source === currentNode!.id);
      if (!nextEdge) {
        break; // No more nodes to execute
      }

      const nextNode = this.scenario.nodes.find((n) => n.id === nextEdge.target);
      if (!nextNode) {
        throw new Error(`Next node ${nextEdge.target} not found`);
      }

      currentNode = nextNode;
    }

    this.context.currentNodeId = null;
  }

  /**
   * Execute a single node
   */
  private async executeNode(node: any): Promise<void> {
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
        await this.callbacks.onStartTransaction(data.tagId || "123456");
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
  private async executeMeterValue(nodeId: string, data: MeterValueNodeData): Promise<void> {
    if (this.callbacks.onSetMeterValue) {
      this.callbacks.onSetMeterValue(data.value);
    }

    // Handle auto-increment mode
    if (data.autoIncrement) {
      const interval = (data.incrementInterval || 10) * 1000;
      const amount = data.incrementAmount || 1000;
      let currentValue = data.value;

      const updateInterval = 100; // Update progress every 100ms
      let elapsed = 0;
      const intervalSeconds = interval / 1000;

      const progressInterval = setInterval(() => {
        elapsed += updateInterval / 1000;
        const remaining = Math.max(0, intervalSeconds - elapsed);

        if (this.callbacks.onNodeProgress) {
          this.callbacks.onNodeProgress(nodeId, remaining, intervalSeconds);
        }

        if (remaining <= 0) {
          clearInterval(progressInterval);
        }
      }, updateInterval);

      await this.sleep(interval);
      clearInterval(progressInterval);

      // Increment value
      currentValue += amount;
      if (this.callbacks.onSetMeterValue) {
        this.callbacks.onSetMeterValue(currentValue);
      }

      // Clear progress
      if (this.callbacks.onNodeProgress) {
        this.callbacks.onNodeProgress(nodeId, 0, intervalSeconds);
      }
    }

    if (data.sendMessage && this.callbacks.onSendMeterValue) {
      await this.callbacks.onSendMeterValue();
    }
  }

  /**
   * Execute delay node with progress updates
   */
  private async executeDelay(nodeId: string, data: DelayNodeData): Promise<void> {
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
  private async executeConnectorPlug(data: ConnectorPlugNodeData): Promise<void> {
    if (this.callbacks.onConnectorPlug) {
      await this.callbacks.onConnectorPlug(data.action);
    }
  }

  /**
   * Pause execution
   */
  public pause(): void {
    if (this.context.state === "running") {
      this.isPaused = true;
      this.context.state = "paused";
      this.notifyStateChange();
    }
  }

  /**
   * Resume execution
   */
  public resume(): void {
    if (this.context.state === "paused") {
      this.isPaused = false;
      this.context.state = "running";
      this.notifyStateChange();
    }
  }

  /**
   * Stop execution
   */
  public stop(): void {
    this.isStopped = true;
    this.context.state = "idle";
    this.context.currentNodeId = null;
    this.notifyStateChange();
  }

  /**
   * Execute next step (for step mode)
   */
  public step(): void {
    if (this.stepMode && this.stepResolve) {
      this.stepResolve();
      this.stepResolve = null;
    }
  }

  /**
   * Get current execution context
   */
  public getContext(): ScenarioExecutionContext {
    return { ...this.context };
  }

  /**
   * Wait if execution is paused
   */
  private async waitIfPaused(): Promise<void> {
    while (this.isPaused && !this.isStopped) {
      await this.sleep(100);
    }
  }

  /**
   * Wait for step command
   */
  private async waitForStep(): Promise<void> {
    if (!this.stepMode) return;

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
