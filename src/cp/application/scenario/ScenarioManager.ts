import { Connector } from "../../domain/connector/Connector";
import { ChargePoint } from "../../domain/charge-point/ChargePoint";
import { ScenarioExecutor } from "./ScenarioExecutor";
import {
  ScenarioDefinition,
  ScenarioExecutionMode,
  ScenarioExecutorCallbacks,
} from "./ScenarioTypes";
import { OCPPStatus } from "../../domain/types/OcppTypes";

/**
 * Scenario Manager
 * Manages multiple scenarios for a single connector
 * - Handles trigger matching (status changes, etc.)
 * - Executes matching scenarios in parallel
 * - Stops running scenarios when new triggers fire
 */
export class ScenarioManager {
  private connector: Connector;
  private chargePoint: ChargePoint;
  private scenarios: Map<string, ScenarioDefinition> = new Map();
  private executors: Map<string, ScenarioExecutor> = new Map();
  private callbacks: ScenarioExecutorCallbacks;

  constructor(
    connector: Connector,
    chargePoint: ChargePoint,
    callbacks: ScenarioExecutorCallbacks
  ) {
    this.connector = connector;
    this.chargePoint = chargePoint;
    this.callbacks = callbacks;

    // Subscribe to connector status changes
    this.connector.events.on("statusChange", (data) => {
      this.handleStatusChange(data.previousStatus as OCPPStatus, data.status as OCPPStatus);
    });
  }

  /**
   * Load scenarios from storage or set directly
   */
  loadScenarios(scenarios: ScenarioDefinition[]): void {
    this.scenarios.clear();
    scenarios.forEach((scenario) => {
      this.scenarios.set(scenario.id, scenario);
    });
  }

  /**
   * Get all scenarios
   */
  getScenarios(): ScenarioDefinition[] {
    return Array.from(this.scenarios.values());
  }

  /**
   * Get a specific scenario by ID
   */
  getScenario(scenarioId: string): ScenarioDefinition | undefined {
    return this.scenarios.get(scenarioId);
  }

  /**
   * Add or update a scenario
   */
  setScenario(scenario: ScenarioDefinition): void {
    this.scenarios.set(scenario.id, scenario);
  }

  /**
   * Remove a scenario
   */
  removeScenario(scenarioId: string): void {
    // Stop if running
    if (this.executors.has(scenarioId)) {
      this.stopScenario(scenarioId);
    }
    this.scenarios.delete(scenarioId);
  }

  /**
   * Get currently executing scenario IDs
   */
  getActiveScenarioIds(): string[] {
    return Array.from(this.executors.keys());
  }

  /**
   * Check if a scenario is currently executing
   */
  isScenarioActive(scenarioId: string): boolean {
    return this.executors.has(scenarioId);
  }

  /**
   * Get execution context for a specific scenario
   * Returns null if the scenario is not currently executing
   */
  getScenarioExecutionContext(scenarioId: string) {
    const executor = this.executors.get(scenarioId);
    if (!executor) {
      return null;
    }
    return executor.getContext();
  }

  /**
   * Handle status change event
   * Finds matching scenarios and executes them in parallel
   */
  private handleStatusChange(fromStatus: OCPPStatus, toStatus: OCPPStatus): void {
    // Find matching scenarios
    const matchingScenarios = this.findMatchingScenarios("statusChange", {
      fromStatus,
      toStatus,
    });

    if (matchingScenarios.length === 0) {
      return;
    }

    console.log(
      `[ScenarioManager] Status changed: ${fromStatus} → ${toStatus}. Found ${matchingScenarios.length} matching scenario(s).`
    );

    // Stop all currently running scenarios
    this.stopAllScenarios();

    // Execute all matching scenarios in parallel
    matchingScenarios.forEach((scenario) => {
      this.executeScenario(
        scenario.id,
        scenario.defaultExecutionMode || "oneshot"
      );
    });
  }

  /**
   * Find scenarios that match a trigger
   */
  private findMatchingScenarios(
    triggerType: string,
    conditions: {
      fromStatus?: OCPPStatus;
      toStatus?: OCPPStatus;
    }
  ): ScenarioDefinition[] {
    const matching: ScenarioDefinition[] = [];

    this.scenarios.forEach((scenario) => {
      // Skip disabled scenarios
      if (scenario.enabled === false) {
        return;
      }

      // Skip if no trigger defined (manual only)
      if (!scenario.trigger) {
        return;
      }

      // Check trigger type
      if (scenario.trigger.type !== triggerType) {
        return;
      }

      // Check conditions for statusChange trigger
      if (triggerType === "statusChange") {
        const triggerConditions = scenario.trigger.conditions;

        // If no conditions, match any status change
        if (!triggerConditions) {
          matching.push(scenario);
          return;
        }

        // Check fromStatus (if specified)
        if (
          triggerConditions.fromStatus &&
          triggerConditions.fromStatus !== conditions.fromStatus
        ) {
          return;
        }

        // Check toStatus (if specified)
        if (
          triggerConditions.toStatus &&
          triggerConditions.toStatus !== conditions.toStatus
        ) {
          return;
        }

        // All conditions matched
        matching.push(scenario);
      }
    });

    return matching;
  }

  /**
   * Execute a specific scenario
   * @param scenarioId Scenario ID to execute
   * @param mode Execution mode (oneshot, loop, step)
   */
  async executeScenario(
    scenarioId: string,
    mode: ScenarioExecutionMode
  ): Promise<void> {
    const scenario = this.scenarios.get(scenarioId);
    if (!scenario) {
      console.error(`[ScenarioManager] Scenario not found: ${scenarioId}`);
      return;
    }

    // Stop if already running
    if (this.executors.has(scenarioId)) {
      this.stopScenario(scenarioId);
    }

    console.log(
      `[ScenarioManager] Executing scenario: ${scenario.name} (${mode})`
    );

    // Create executor
    const executor = new ScenarioExecutor(scenario, this.callbacks);
    this.executors.set(scenarioId, executor);

    try {
      await executor.start(mode);
    } catch (error) {
      console.error(`[ScenarioManager] Scenario execution error:`, error);
    } finally {
      // Clean up when completed
      this.executors.delete(scenarioId);
    }
  }

  /**
   * Stop a specific scenario
   */
  stopScenario(scenarioId: string): void {
    const executor = this.executors.get(scenarioId);
    if (executor) {
      console.log(`[ScenarioManager] Stopping scenario: ${scenarioId}`);
      executor.stop();
      this.executors.delete(scenarioId);
    }
  }

  /**
   * Stop all running scenarios
   */
  stopAllScenarios(): void {
    const activeIds = Array.from(this.executors.keys());
    if (activeIds.length > 0) {
      console.log(
        `[ScenarioManager] Stopping ${activeIds.length} active scenario(s)`
      );
      activeIds.forEach((id) => this.stopScenario(id));
    }
  }

  /**
   * Manual execution (from UI)
   * Does not stop other running scenarios
   */
  async manualExecute(
    scenarioId: string,
    mode: ScenarioExecutionMode
  ): Promise<void> {
    const scenario = this.scenarios.get(scenarioId);
    if (!scenario) {
      throw new Error(`Scenario not found: ${scenarioId}`);
    }

    console.log(
      `[ScenarioManager] Manual execution: ${scenario.name} (${mode})`
    );

    await this.executeScenario(scenarioId, mode);
  }

  /**
   * Pause a running scenario
   */
  pauseScenario(scenarioId: string): void {
    const executor = this.executors.get(scenarioId);
    if (executor) {
      executor.pause();
    }
  }

  /**
   * Resume a paused scenario
   */
  resumeScenario(scenarioId: string): void {
    const executor = this.executors.get(scenarioId);
    if (executor) {
      executor.resume();
    }
  }

  /**
   * Step through a scenario (for debugging)
   */
  stepScenario(scenarioId: string): void {
    const executor = this.executors.get(scenarioId);
    if (executor) {
      executor.step();
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.stopAllScenarios();
    this.scenarios.clear();
    this.executors.clear();
  }
}
