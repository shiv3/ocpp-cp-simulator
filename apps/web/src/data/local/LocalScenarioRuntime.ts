import {
  isAutoStartKeyOf,
  matchAutoStart,
} from "@ocpp-cp-simulator/core/cp/application/scenario/autoStart";
import { ScenarioManager } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioManager";
import { createScenarioExecutorCallbacks } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioRuntime";
import type {
  ScenarioDefinition,
  ScenarioEvents,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { EventEmitter } from "@ocpp-cp-simulator/core/cp/shared/EventEmitter";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { Connector } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
import type { SqliteScenarioRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/SqliteScenarioRepository";
import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type { ScenarioRunRecorder } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunRecorder";
import type { ChargePointEvent } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";

type ScenarioDefinitionSource = Pick<
  SqliteScenarioRepository,
  "listByConnector" | "subscribe"
>;

/** Saved definitions that apply to `connectorId`. Definitions saved before
 *  `targetType` existed have none and apply to every connector. */
function scopedToConnector(
  definitions: ScenarioDefinition[],
  connectorId: number,
): ScenarioDefinition[] {
  return definitions.filter((definition) =>
    definition.targetType === "connector"
      ? definition.targetId === connectorId
      : definition.targetType !== "chargePoint",
  );
}

/**
 * Browser (Local mode) scenario runtime for one charge point — the
 * counterpart of the daemon's scenario handling in `CLIChargePointService`.
 *
 * For every connector it owns a `ScenarioManager`, keeps it loaded with the
 * connector's saved definitions, auto-starts the eligible one when the CP
 * comes up or the connector reaches a status, and reports run progress as
 * `scenario-*` service events. It runs whether or not any UI is mounted.
 */
export class LocalScenarioRuntime {
  private readonly unsubscribes: Array<() => void> = [];
  private disposed = false;
  /** Per connector id: its manager and the emitter the manager reports on. */
  private readonly slots = new Map<
    number,
    { manager: ScenarioManager; events: EventEmitter<ScenarioEvents> }
  >();

  constructor(
    private readonly chargePoint: ChargePoint,
    private readonly definitions: ScenarioDefinitionSource,
    private readonly emit: (event: ChargePointEvent) => void,
    /** #394: writes each finished run's report to the run history. */
    private readonly recorder?: ScenarioRunRecorder,
  ) {
    chargePoint.connectors.forEach((connector) => this.attach(connector));

    this.unsubscribes.push(
      chargePoint.events.on("statusChange", ({ status }) => {
        if (status !== OCPPStatus.Available) return;
        // Connector statuses reported during BootNotification arrive before
        // the CP is Available, when the status auto-start gate is still
        // closed: re-evaluate them now that it is open.
        chargePoint.connectors.forEach((connector) => {
          this.tryAutoStart(connector, "connect");
          this.tryAutoStart(connector, "status");
        });
      }),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe());
    [...this.slots.keys()].forEach((connectorId) => this.release(connectorId));
  }

  /** The scenario manager of connector `connectorId`, while it is attached. */
  scenarioManager(connectorId: number): ScenarioManager | undefined {
    return this.slots.get(connectorId)?.manager;
  }

  /** Replaces the connector's manager; the previous one is destroyed. */
  setScenarioManager(connectorId: number, manager: ScenarioManager): void {
    const slot = this.slots.get(connectorId);
    if (!slot) {
      this.slots.set(connectorId, {
        manager,
        events: new EventEmitter<ScenarioEvents>(),
      });
      return;
    }
    slot.manager.destroy();
    slot.manager = manager;
  }

  /** Destroys the connector's manager, then drops its event listeners. */
  private release(connectorId: number): void {
    const slot = this.slots.get(connectorId);
    if (!slot) return;
    slot.manager.destroy();
    slot.events.removeAllListeners();
    this.slots.delete(connectorId);
  }

  private attach(connector: Connector): void {
    const { chargePoint } = this;
    const events = new EventEmitter<ScenarioEvents>();
    const manager = new ScenarioManager(
      connector,
      chargePoint,
      () => createScenarioExecutorCallbacks({ chargePoint, connector }),
      events,
      this.recorder,
    );
    this.slots.set(connector.id, { manager, events });
    this.unsubscribes.push(
      connector.events.on("disposed", () => this.release(connector.id)),
    );

    this.forwardScenarioEvents(connector, events);

    let persistedIds = new Set<string>();
    const reload = () => {
      // The store's subscribe() delivers its first callback asynchronously,
      // possibly after dispose().
      if (this.disposed) return;
      const saved = scopedToConnector(
        this.definitions.listByConnector(chargePoint.id, connector.id),
        connector.id,
      );
      // Upsert rather than replace: a definition loaded for a one-off run
      // (loadScenario, runScenarioTemplate) is not in the store and must
      // survive an unrelated save. A deleted definition is dropped (and
      // stopped if it was running).
      const nextIds = new Set(saved.map((definition) => definition.id));
      persistedIds.forEach((id) => {
        if (!nextIds.has(id)) manager.removeScenario(id);
      });
      saved.forEach((definition) => manager.setScenario(definition));
      persistedIds = nextIds;
      this.tryAutoStart(connector, "connect");
      this.tryAutoStart(connector, "status");
    };
    reload();
    this.unsubscribes.push(
      this.definitions.subscribe(chargePoint.id, connector.id, reload),
    );

    this.unsubscribes.push(
      connector.events.on("statusChange", ({ status, previousStatus }) => {
        if (status !== previousStatus) this.tryAutoStart(connector, "status");
      }),
    );
  }

  /**
   * Runs the first saved scenario that auto-starts on `trigger` (rules in
   * `matchAutoStart`, shared with the daemon), unless the CP is not
   * Available, a scenario is already running on the connector, or this
   * exact scenario already fired (dedup key on the connector).
   */
  private tryAutoStart(
    connector: Connector,
    trigger: "connect" | "status",
  ): void {
    if (this.chargePoint.status !== OCPPStatus.Available) return;
    const manager = this.scenarioManager(connector.id);
    if (!manager) return;

    for (const definition of manager.getScenarios()) {
      if (definition.enabled === false) {
        if (
          isAutoStartKeyOf(connector.lastAutoStartedScenarioKey, definition.id)
        ) {
          connector.lastAutoStartedScenarioKey = null;
        }
        continue;
      }
      const match = matchAutoStart(
        definition,
        trigger,
        connector.status as OCPPStatus,
      );
      if (!match) continue;
      if (manager.getActiveScenarioIds().length > 0) return;
      if (connector.lastAutoStartedScenarioKey === match.key) return;

      connector.lastAutoStartedScenarioKey = match.key;
      void manager.executeScenario(definition.id);
      return;
    }
  }

  private forwardScenarioEvents(
    connector: Connector,
    events: EventEmitter<ScenarioEvents>,
  ): void {
    const connectorId = connector.id;
    // #394: the run id the manager minted, on every lifecycle event.
    const runIdOf = (scenarioId: string) => ({
      runId: this.scenarioManager(connectorId)?.getRunId(scenarioId),
    });
    this.unsubscribes.push(
      events.on("execution.started", ({ scenarioId }) =>
        this.emit({
          type: "scenario-started",
          connectorId,
          scenarioId,
          ...runIdOf(scenarioId),
        }),
      ),
      events.on("node.execute", ({ scenarioId, nodeId }) =>
        this.emit({
          type: "scenario-node-execute",
          connectorId,
          scenarioId,
          nodeId,
          ...runIdOf(scenarioId),
        }),
      ),
      events.on("execution.completed", ({ scenarioId }) =>
        this.emit({
          type: "scenario-completed",
          connectorId,
          scenarioId,
          ...runIdOf(scenarioId),
        }),
      ),
      // A stop ends the run too; the daemon reports it as completed, and so
      // the console's run tracking does not need a separate case.
      events.on("execution.stopped", ({ scenarioId }) =>
        this.emit({
          type: "scenario-completed",
          connectorId,
          scenarioId,
          ...runIdOf(scenarioId),
        }),
      ),
      events.on("execution.error", ({ scenarioId, error }) =>
        this.emit({
          type: "scenario-error",
          connectorId,
          scenarioId,
          error,
          ...runIdOf(scenarioId),
        }),
      ),
      events.on("wait.intervention", ({ scenarioId, nodeId, kind }) =>
        this.emit({
          type: "scenario-wait-changed",
          connectorId,
          scenarioId,
          nodeId,
          kind,
          ...runIdOf(scenarioId),
        }),
      ),
    );
  }
}
