import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { Connector } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
import { AutoTrafficRunner } from "@ocpp-cp-simulator/core/cp/application/services/AutoTrafficRunner";
import {
  AUTO_TRAFFIC_ID_TAG,
  AutoTrafficIdTagPicker,
  autoTrafficVehicleLabel,
  autoTrafficVehiclePatch,
  defaultAutoTrafficConfig,
  emptyAutoTrafficCounters,
  validateAutoTrafficConfig,
  type AutoTrafficConfig,
  type AutoTrafficCounters,
} from "@ocpp-cp-simulator/core/cp/domain/connector/AutoTraffic";
import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import { LogType } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import type { ChargePointInitOptions } from "../types";

/** What the auto-traffic functions need from `CLIChargePointService`. */
export interface AutoTrafficHost {
  readonly chargePoint: ChargePoint;
  readonly init: ChargePointInitOptions;
  readonly autoTraffic: Map<number, AutoTrafficRunner>;
  readonly autoTrafficConfigs: Map<number, AutoTrafficConfig>;
  readonly autoTrafficPickers: Map<number, AutoTrafficIdTagPicker | null>;
  /** True while any scenario executor is running. */
  scenarioActive(): boolean;
  requireConnector(connectorId: number): Connector;
  stopTransaction(connectorId: number): void;
}

/**
 * Seeded background traffic (#300).
 *
 * Modelled on the auto-meter config above: a per-connector runtime
 * behaviour set by RPC, independent of whether a scenario is loaded. The
 * runner is replaced rather than mutated so the seed takes effect — a
 * reconfigure that kept the old stream would not be reproducible.
 */
export function setAutoTrafficConfig(
  host: AutoTrafficHost,
  connectorId: number,
  config: AutoTrafficConfig,
): void {
  host.requireConnector(connectorId);
  const invalid = validateAutoTrafficConfig(config);
  if (invalid) throw new Error(invalid);

  host.autoTrafficConfigs.set(connectorId, config);
  const existing = host.autoTraffic.get(connectorId);
  if (existing) {
    // The picker restarts with the runner's seeded stream.
    host.autoTrafficPickers.set(
      connectorId,
      config.enabled ? autoTrafficIdTagPicker(host, connectorId, config) : null,
    );
    existing.reconfigure(config);
    if (!config.enabled) {
      host.autoTraffic.delete(connectorId);
      host.autoTrafficPickers.delete(connectorId);
    }
    return;
  }
  if (!config.enabled) return;

  host.autoTrafficPickers.set(
    connectorId,
    autoTrafficIdTagPicker(host, connectorId, config),
  );
  const runner = new AutoTrafficRunner(config, host.init.cpId, connectorId, {
    // One tag per session (#603), from the pool when the charge point has
    // one.
    idTag: () =>
      host.autoTrafficPickers.get(connectorId)?.next() ?? AUTO_TRAFFIC_ID_TAG,
    // A cycle starts only on an Accepted charge point, an Available
    // connector and no active transaction (#603); otherwise it is skipped.
    startBlocker: (id) => {
      if (host.chargePoint.poweredOff) return "the charge point has no power";
      if (!host.chargePoint.bootAccepted) {
        return "the charge point is not Accepted";
      }
      const connector = host.chargePoint.getConnector(id);
      if (!connector) return `connector ${id} not found`;
      if (connector.hasRunningTransaction) return "a transaction is active";
      if (connector.status !== OCPPStatus.Available) {
        return `the connector is ${connector.status}`;
      }
      return null;
    },
    // Awaited: a CSMS that refuses the tag must be counted as a refusal, not
    // reported as a started session.
    authorize: async (_id, idTag) => {
      const status = await host.chargePoint.authorizeAndWait(idTag);
      return status === "Accepted";
    },
    // `intent` is set under `sessionModel: "intent"` (#327): the session
    // opens at the drawn SoC, targets the drawn SoC and stops there.
    startTransaction: async (id, idTag, intent, vehicle) => {
      // #627: the drawn vehicle becomes the connector's, before the start,
      // so the transaction (battery capacity, opening SoC) and every
      // MeterValues of the session read the vehicle the traffic drew.
      let restore: (() => void) | null = null;
      if (vehicle) {
        const connector = host.requireConnector(id);
        const previous = connector.evSettings;
        const wasOverridden = connector.applyEvSettingsOverride(
          autoTrafficVehiclePatch(vehicle),
        );
        // #846: a start that does not begin gives the connector back the
        // vehicle it had, and the override only if it had one.
        restore = () => {
          connector.evSettings = previous;
          if (!wasOverridden) connector.clearEvSettingsOverride();
        };
        host.chargePoint.logger.info(
          `[auto-traffic] ${host.init.cpId}/${id} vehicle ${autoTrafficVehicleLabel(vehicle)}`,
          LogType.TRANSACTION,
        );
      }
      let started = false;
      try {
        const outcome = await host.chargePoint.startTransaction(
          idTag,
          id,
          undefined,
          intent?.initialSoc,
          intent
            ? { targetSoc: intent.targetSoc, stopAtTarget: true }
            : undefined,
        );
        started = outcome.started;
      } finally {
        if (!started) restore?.();
      }
      return started;
    },
    sessionRunning: (id) =>
      host.chargePoint.getConnector(id)?.hasRunningTransaction ?? false,
    stopTransaction: async (id) => host.stopTransaction(id),
    poweredOff: () => host.chargePoint.poweredOff,
    // A scenario owns the connector while any executor is running: a run's
    // verdict must never depend on whether background traffic fired.
    scenarioActive: () => host.scenarioActive(),
    log: (message) =>
      host.chargePoint.logger.info(message, LogType.TRANSACTION),
  });
  host.autoTraffic.set(connectorId, runner);
  runner.start();
}

/** The traffic's idTag stream, or `null` without a pool (#603). */
function autoTrafficIdTagPicker(
  host: AutoTrafficHost,
  connectorId: number,
  config: AutoTrafficConfig,
): AutoTrafficIdTagPicker | null {
  const pool = host.chargePoint.idTagPoolInfo();
  if (!pool) return null;
  return new AutoTrafficIdTagPicker(
    // Read at each draw: `--watch` swaps the pool's list (#314).
    () => host.chargePoint.idTagPoolInfo()?.tags ?? pool.tags,
    config.idTagStrategy ?? pool.distribution,
    config.seed,
    host.init.cpId,
    connectorId,
    config.cpIndex,
  );
}

export function getAutoTrafficConfig(
  host: AutoTrafficHost,
  connectorId: number,
): AutoTrafficConfig {
  host.requireConnector(connectorId);
  return (
    host.autoTrafficConfigs.get(connectorId) ?? {
      ...defaultAutoTrafficConfig,
    }
  );
}

/** Per-connector counters, the assertion surface for a load run. */
export function getAutoTrafficCounters(
  host: AutoTrafficHost,
  connectorId: number,
): AutoTrafficCounters {
  return (
    host.autoTraffic.get(connectorId)?.counters ?? emptyAutoTrafficCounters()
  );
}
