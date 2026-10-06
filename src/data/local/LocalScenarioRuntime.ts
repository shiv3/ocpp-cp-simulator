import {
  isAutoStartKeyOf,
  matchAutoStart,
} from "../../cp/application/scenario/autoStart";
import { ScenarioManager } from "../../cp/application/scenario/ScenarioManager";
import { createScenarioExecutorCallbacks } from "../../cp/application/scenario/ScenarioRuntime";
import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import type { Connector } from "../../cp/domain/connector/Connector";
import type { SqliteScenarioRepository } from "../../cp/domain/persistence/SqliteScenarioRepository";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import type { ChargePointEvent } from "../interfaces/ChargePointService";

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

  constructor(
    private readonly chargePoint: ChargePoint,
    private readonly definitions: ScenarioDefinitionSource,
    private readonly emit: (event: ChargePointEvent) => void,
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
    this.chargePoint.connectors.forEach((connector) =>
      connector.clearScenarioManager(),
    );
  }

  private attach(connector: Connector): void {
    const { chargePoint } = this;
    const manager = new ScenarioManager(
      connector,
      chargePoint,
      () => createScenarioExecutorCallbacks({ chargePoint, connector }),
      connector.scenarioEvents,
    );
    connector.setScenarioManager(manager);

    this.forwardScenarioEvents(connector);

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
    const manager = connector.scenarioManager;
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

  private forwardScenarioEvents(connector: Connector): void {
    const events = connector.scenarioEvents;
    const connectorId = connector.id;
    this.unsubscribes.push(
      events.on("execution.started", ({ scenarioId }) =>
        this.emit({ type: "scenario-started", connectorId, scenarioId }),
      ),
      events.on("node.execute", ({ scenarioId, nodeId }) =>
        this.emit({
          type: "scenario-node-execute",
          connectorId,
          scenarioId,
          nodeId,
        }),
      ),
      events.on("execution.completed", ({ scenarioId }) =>
        this.emit({ type: "scenario-completed", connectorId, scenarioId }),
      ),
      // A stop ends the run too; the daemon reports it as completed, and so
      // the console's run tracking does not need a separate case.
      events.on("execution.stopped", ({ scenarioId }) =>
        this.emit({ type: "scenario-completed", connectorId, scenarioId }),
      ),
      events.on("execution.error", ({ scenarioId, error }) =>
        this.emit({ type: "scenario-error", connectorId, scenarioId, error }),
      ),
      events.on("wait.intervention", ({ scenarioId, nodeId, kind }) =>
        this.emit({
          type: "scenario-wait-changed",
          connectorId,
          scenarioId,
          nodeId,
          kind,
        }),
      ),
    );
  }
}
