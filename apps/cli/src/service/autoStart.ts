import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type { ScenarioExecutor } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioExecutor";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  isAutoStartKeyOf,
  matchAutoStart,
} from "@ocpp-cp-simulator/core/cp/application/scenario/autoStart";
import type { CLIChargePointService } from "../service";

/** What the auto-start functions need from `CLIChargePointService`. */
export interface AutoStartHost extends Pick<
  CLIChargePointService,
  "runScenario"
> {
  readonly chargePoint: ChargePoint;
  readonly executors: Map<string, ScenarioExecutor>;
  readonly scenarios: Map<
    string,
    { readonly definition: ScenarioDefinition; readonly connectorId: number }
  >;
}

/**
 * Auto-start for `triggerOn: "connect"` (the default), as
 * LocalScenarioRuntime does in the browser's Local mode. Called when the CP reaches
 * Available; runs the first matching loaded scenario per connector.
 */
export function handleConnectAutoStart(host: AutoStartHost): void {
  for (const connector of host.chargePoint.connectors.values()) {
    tryAutoStartForConnector(host, connector.id, "connect", null);
  }
}

/**
 * Mirror for `triggerOn: "status"`: fires when the bound connector reaches
 * a specific status (e.g. Charging). Connector statusChange events feed in.
 */
export function handleStatusAutoStart(
  host: AutoStartHost,
  connectorId: number,
  toStatus: OCPPStatus,
): void {
  tryAutoStartForConnector(host, connectorId, "status", toStatus);
}

/**
 * Shared auto-start engine: walks loaded scenarios for `connectorId`,
 * picks the first manual-trigger scenario whose Start node's `triggerOn`
 * matches `mode` (and `targetStatus` for the "status" case), and runs it
 * via runScenario(). Dedup uses Connector.lastAutoStartedScenarioKey so a
 * status oscillation (or a reconnect that re-fires Available) doesn't
 * restart an already-fired scenario. The browser runtime
 * (LocalScenarioRuntime) applies the same rules through matchAutoStart.
 */
export function tryAutoStartForConnector(
  host: AutoStartHost,
  connectorId: number,
  mode: "connect" | "status",
  connectorStatus: OCPPStatus | null,
): void {
  if (host.chargePoint.status !== OCPPStatus.Available) return;
  const connector = host.chargePoint.connectors.get(connectorId);
  if (!connector) return;

  for (const [scenarioId, entry] of host.scenarios) {
    if (entry.connectorId !== connectorId) continue;
    const def = entry.definition;
    if (def.enabled === false) {
      if (isAutoStartKeyOf(connector.lastAutoStartedScenarioKey, def.id)) {
        connector.lastAutoStartedScenarioKey = null;
      }
      continue;
    }
    // Defensive: a misshapen scenario (wrong JSON shape, half-parsed
    // wire payload, …) shouldn't take down the statusChange listener.
    // Skip silently so other scenarios still get a chance.
    if (!Array.isArray(def.nodes)) {
      process.stderr.write(
        `[CLI] tryAutoStartForConnector: scenario ${scenarioId} has no nodes array; skipping\n`,
      );
      continue;
    }
    // The eligibility rules (manual trigger, no StatusTrigger node,
    // Start node's triggerOn / targetStatus) are shared with the browser
    // runtime (LocalScenarioRuntime) so both fire the same scenarios.
    const match = matchAutoStart(def, mode, connectorStatus);
    if (!match) continue;

    // Skip if anything is already running for this connector — matches
    // ScenarioManager.handleStatusChange's one-scenario-at-a-time rule.
    let active = false;
    for (const [otherId, otherEntry] of host.scenarios) {
      if (otherEntry.connectorId !== connectorId) continue;
      if (host.executors.has(otherId)) {
        active = true;
        break;
      }
    }
    if (active) return;

    // Dedup: re-emitting Available (e.g. after a CSMS reconnect) doesn't
    // restart an unchanged scenario.
    if (connector.lastAutoStartedScenarioKey === match.key) return;

    try {
      connector.lastAutoStartedScenarioKey = match.key;
      host.runScenario(connectorId, scenarioId);
    } catch (err) {
      connector.lastAutoStartedScenarioKey = null;
      process.stderr.write(
        `[CLI] connect/status auto-start failed for ${scenarioId}: ${
          err instanceof Error ? err.message : err
        }\n`,
      );
    }
    // One scenario per connector per trigger — matches the browser.
    return;
  }
}

/**
 * Inline mirror of ScenarioManager.handleStatusChange — finds the first
 * loaded scenario whose `statusChange` trigger matches the transition
 * and runs it via runScenario(). Skips scenarios that are disabled,
 * already running, or whose ChargePoint isn't `Available` (matches the
 * browser-side guard in ScenarioManager.handleStatusChange; an explicit
 * runScenario has no such guard in either runtime, #425).
 */
export function handleStatusChangeAutoTrigger(
  host: AutoStartHost,
  connectorId: number,
  fromStatus: OCPPStatus,
  toStatus: OCPPStatus,
): void {
  if (host.chargePoint.status !== OCPPStatus.Available) return;
  for (const [scenarioId, entry] of host.scenarios) {
    if (entry.connectorId !== connectorId) continue;
    const def = entry.definition;
    if (def.enabled === false) continue;
    const trigger = def.trigger;
    if (!trigger || trigger.type !== "statusChange") continue;
    const cond = trigger.conditions;
    if (cond?.fromStatus && cond.fromStatus !== fromStatus) continue;
    if (cond?.toStatus && cond.toStatus !== toStatus) continue;
    // Don't restart if it's currently running — let it finish first.
    if (host.executors.has(scenarioId)) continue;
    try {
      host.runScenario(connectorId, scenarioId);
    } catch (err) {
      process.stderr.write(
        `[CLI] statusChange auto-trigger failed for ${scenarioId}: ${
          err instanceof Error ? err.message : err
        }\n`,
      );
    }
    // One scenario per status transition — matches ScenarioManager.
    return;
  }
}
