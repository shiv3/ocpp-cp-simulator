import { Connector } from "../../domain/connector/Connector";
import { ChargePoint } from "../../domain/charge-point/ChargePoint";
import { ScenarioExecutor } from "./ScenarioExecutor";
import { ScenarioRunStateError } from "../../domain/errors/ScenarioRunStateError";
import {
  ScenarioDefinition,
  ScenarioExecutorCallbacks,
  ScenarioEvents,
} from "./ScenarioTypes";
import { OCPPStatus } from "../../domain/types/OcppTypes";
import type { EventEmitter } from "../../shared/EventEmitter";

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
  private callbacks:
    ScenarioExecutorCallbacks | (() => ScenarioExecutorCallbacks);
  private eventEmitter?: EventEmitter<ScenarioEvents>;
  private readonly unsubscribeStatusChange: () => void;
  /**
   * #333: the run that owns the connector's EV settings override — the
   * executor that last *applied* its `evSettings`, compared by reference.
   *
   * Written only once a run's `onSetEVSettings` has returned (see
   * {@link executeScenario}), never from what a definition declares: a
   * definition installed under a running id may never run, and one whose
   * settings are refused claimed nothing. Cleared by {@link
   * disownEvSettingsOverride} when an operator takes the override over, and
   * when the owning run releases it. The browser twin of the daemon's
   * `_evSettingsOwnerByConnector`; deliberately not on the `Connector`, whose
   * other override writers have no run to name.
   */
  private evSettingsOwner: ScenarioExecutor | null = null;

  constructor(
    connector: Connector,
    chargePoint: ChargePoint,
    /** Either one callbacks object shared by every run, or a factory
     *  called once per run — a long-lived manager passes a factory so
     *  per-run state in the callbacks (e.g. the run start time) is fresh. */
    callbacks: ScenarioExecutorCallbacks | (() => ScenarioExecutorCallbacks),
    eventEmitter?: EventEmitter<ScenarioEvents>,
  ) {
    this.connector = connector;
    this.chargePoint = chargePoint;
    this.callbacks = callbacks;
    this.eventEmitter = eventEmitter;

    // Subscribe to connector status changes
    this.unsubscribeStatusChange = this.connector.events.on(
      "statusChange",
      (data) => {
        this.handleStatusChange(
          data.previousStatus as OCPPStatus,
          data.status as OCPPStatus,
        );
      },
    );
  }

  /**
   * Evaluate status change explicitly (used when scenarios are reloaded)
   */
  public evaluateStatus(fromStatus: OCPPStatus, toStatus: OCPPStatus): void {
    this.handleStatusChange(fromStatus, toStatus);
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
  private handleStatusChange(
    fromStatus: OCPPStatus,
    toStatus: OCPPStatus,
  ): void {
    console.log(
      `[ScenarioManager] handleStatusChange called: ${fromStatus} → ${toStatus}`,
    );

    // Find matching scenarios
    const matchingScenarios = this.findMatchingScenarios("statusChange", {
      fromStatus,
      toStatus,
    });

    console.log(
      `[ScenarioManager] Found ${matchingScenarios.length} matching scenario(s) for ${fromStatus} → ${toStatus}`,
    );

    if (matchingScenarios.length === 0) {
      return;
    }

    // Only the automatic trigger waits for an Available charge point, like
    // the daemon's handleStatusChangeAutoTrigger. It checks before stopping
    // anything: a trigger that cannot start must not end a manual run, which
    // starts whatever the status (executeScenario / manualExecute, #425).
    if (this.chargePoint.status !== OCPPStatus.Available) {
      console.warn(
        `[ScenarioManager] ChargePoint status is ${this.chargePoint.status}. Status-triggered scenario skipped.`,
      );
      return;
    }

    console.log(
      `[ScenarioManager] Status changed: ${fromStatus} → ${toStatus}. Found ${matchingScenarios.length} matching scenario(s).`,
    );

    // Stop all currently running scenarios
    this.stopAllScenarios();

    // Execute only the first matching scenario (one scenario per connector)
    if (matchingScenarios.length > 0) {
      const scenario = matchingScenarios[0];
      this.executeScenario(scenario.id);

      if (matchingScenarios.length > 1) {
        console.warn(
          `[ScenarioManager] Multiple scenarios matched, but only executing the first one: ${scenario.name}`,
        );
      }
    }
  }

  /**
   * Find scenarios that match a trigger
   */
  private findMatchingScenarios(
    triggerType: string,
    conditions: {
      fromStatus?: OCPPStatus;
      toStatus?: OCPPStatus;
    },
  ): ScenarioDefinition[] {
    const matching: ScenarioDefinition[] = [];

    console.log(
      `[ScenarioManager] findMatchingScenarios: triggerType=${triggerType}, conditions=`,
      conditions,
      `total scenarios=${this.scenarios.size}`,
    );

    this.scenarios.forEach((scenario) => {
      console.log(
        `[ScenarioManager] Checking scenario: ${scenario.name}, enabled=${scenario.enabled}, trigger=`,
        scenario.trigger,
      );

      // Skip disabled scenarios
      if (scenario.enabled === false) {
        console.log(
          `[ScenarioManager] Skipping disabled scenario: ${scenario.name}`,
        );
        return;
      }

      // Skip if no trigger defined (manual only)
      if (!scenario.trigger) {
        console.log(
          `[ScenarioManager] Skipping scenario without trigger: ${scenario.name}`,
        );
        return;
      }

      // Check trigger type
      if (scenario.trigger.type !== triggerType) {
        console.log(
          `[ScenarioManager] Trigger type mismatch: ${scenario.trigger.type} !== ${triggerType}`,
        );
        return;
      }

      // Check conditions for statusChange trigger
      if (triggerType === "statusChange") {
        const triggerConditions = scenario.trigger.conditions;

        // If no conditions, match any status change
        if (!triggerConditions) {
          console.log(
            `[ScenarioManager] No conditions, matching: ${scenario.name}`,
          );
          matching.push(scenario);
          return;
        }

        // Check fromStatus (if specified)
        if (
          triggerConditions.fromStatus &&
          triggerConditions.fromStatus !== conditions.fromStatus
        ) {
          console.log(
            `[ScenarioManager] fromStatus mismatch: ${triggerConditions.fromStatus} !== ${conditions.fromStatus}`,
          );
          return;
        }

        // Check toStatus (if specified)
        if (
          triggerConditions.toStatus &&
          triggerConditions.toStatus !== conditions.toStatus
        ) {
          console.log(
            `[ScenarioManager] toStatus mismatch: ${triggerConditions.toStatus} !== ${conditions.toStatus}`,
          );
          return;
        }

        // All conditions matched
        console.log(
          `[ScenarioManager] All conditions matched! Adding: ${scenario.name}`,
        );
        matching.push(scenario);
      }
    });

    return matching;
  }

  /**
   * Execute a specific scenario (always one-shot), whatever the charge
   * point's status — like the daemon's runScenario (#425).
   * @param scenarioId Scenario ID to execute
   */
  async executeScenario(scenarioId: string): Promise<void> {
    const scenario = this.scenarios.get(scenarioId);
    if (!scenario) {
      console.error(`[ScenarioManager] Scenario not found: ${scenarioId}`);
      return;
    }

    // Stop if already running
    if (this.executors.has(scenarioId)) {
      this.stopScenario(scenarioId);
    }

    console.log(`[ScenarioManager] Executing scenario: ${scenario.name}`);

    // Create executor with event emitter
    const executor: ScenarioExecutor = new ScenarioExecutor(
      scenario,
      this.recordingEvSettingsClaim(
        typeof this.callbacks === "function"
          ? this.callbacks()
          : this.callbacks,
        () => executor,
      ),
      this.eventEmitter,
    );
    this.executors.set(scenarioId, executor);

    try {
      await executor.start();
    } catch (error) {
      console.error(`[ScenarioManager] Scenario execution error:`, error);
    } finally {
      // Clean up when completed — but only our own slot: a re-run under the
      // same id stops this run and installs its executor before this
      // `finally` runs, and must stay stoppable.
      if (this.executors.get(scenarioId) === executor) {
        this.executors.delete(scenarioId);
      }
      this.releaseEvSettingsOverride(executor);
    }
  }

  /**
   * `callbacks` with `onSetEVSettings` recording the run as the owner of the
   * EV settings override (#333) once the write has returned — never before,
   * and never if it throws. Without that callback there is nothing to claim.
   *
   * In the same tick when the write is synchronous (the connector's, as
   * `createScenarioExecutorCallbacks` makes it): the override is marked from
   * that moment, so a stop in the same tick must already find its owner.
   */
  private recordingEvSettingsClaim(
    callbacks: ScenarioExecutorCallbacks,
    run: () => ScenarioExecutor,
  ): ScenarioExecutorCallbacks {
    const apply = callbacks.onSetEVSettings;
    if (!apply) return callbacks;
    return {
      ...callbacks,
      onSetEVSettings: (settings) => {
        const applied = apply(settings);
        // A claim that lands after its run was stopped is released by that
        // run's own `finally`, which the executor reaches only after this.
        if (applied instanceof Promise) {
          return applied.then(() => {
            this.evSettingsOwner = run();
          });
        }
        this.evSettingsOwner = run();
      },
    };
  }

  /**
   * Release the EV settings override if `ending` is the run that owns it
   * (#105, #333) — the one comparison the daemon's
   * `shouldReleaseEvSettingsOverride` makes:
   *
   * 1. **Release only what this run set.** A run that declared no
   *    `evSettings`, or whose settings were refused, never claimed, and an
   *    operator set during the run disowned it: an override nobody's run set
   *    survives.
   * 2. **Do not release what someone else claimed since.** A concurrent or
   *    replacement run that applied its own settings owns the override.
   * 3. **Do release on ordinary completion and on stop.** Nothing but a later
   *    claim or an operator set moves the owner, so on either end it is still
   *    this run's — whatever definition is installed under its id by then.
   */
  private releaseEvSettingsOverride(ending: ScenarioExecutor): void {
    if (this.evSettingsOwner !== ending) return;
    this.evSettingsOwner = null;
    this.connector.clearEvSettingsOverride();
  }

  /**
   * An operator set the connector's EV settings outside any run (#105): the
   * override is theirs now, so the run that claimed it earlier no longer
   * releases it when it ends. Call after `applyEvSettingsOverride`.
   */
  disownEvSettingsOverride(): void {
    this.evSettingsOwner = null;
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
      // Asked of the run being stopped, not of the definition now installed
      // under its id (#333): that one may never have run.
      this.releaseEvSettingsOverride(executor);
    }
  }

  /**
   * Stop all running scenarios
   */
  stopAllScenarios(): void {
    const activeIds = Array.from(this.executors.keys());
    if (activeIds.length > 0) {
      console.log(
        `[ScenarioManager] Stopping ${activeIds.length} active scenario(s)`,
      );
      activeIds.forEach((id) => this.stopScenario(id));
    }
  }

  /**
   * Manual execution (from UI). Does not stop other running scenarios.
   */
  async manualExecute(scenarioId: string): Promise<void> {
    const scenario = this.scenarios.get(scenarioId);
    if (!scenario) {
      throw new Error(`Scenario not found: ${scenarioId}`);
    }

    console.log(`[ScenarioManager] Manual execution: ${scenario.name}`);

    await this.executeScenario(scenarioId);
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

  /** #240: push the parked wait's deadline back by `seconds`. */
  extendWait(scenarioId: string, seconds: number): void {
    this.requireExecutor(scenarioId).extendWait(seconds);
  }

  /** #240: withdraw the parked wait and arm it again with its full timeout. */
  retryWait(scenarioId: string): void {
    this.requireExecutor(scenarioId).retryWait();
  }

  /** #240: move past the parked wait without the awaited event. */
  continueWait(scenarioId: string): void {
    this.requireExecutor(scenarioId).continueWait();
  }

  private requireExecutor(scenarioId: string): ScenarioExecutor {
    const executor = this.executors.get(scenarioId);
    if (!executor) {
      throw new ScenarioRunStateError(`Scenario ${scenarioId} is not running`);
    }
    return executor;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    // A destroyed manager must stop reacting to the connector: otherwise
    // a replaced manager keeps firing statusChange-triggered scenarios.
    this.unsubscribeStatusChange();
    this.stopAllScenarios();
    this.scenarios.clear();
    this.executors.clear();
  }
}
