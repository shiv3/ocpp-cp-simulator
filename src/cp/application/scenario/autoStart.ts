import type { OCPPStatus } from "../../domain/types/OcppTypes";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
  type StartNodeData,
} from "./ScenarioTypes";

/** What just happened on the connector: the CP came up (`connect`) or the
 *  connector reached a status (`status`). */
export type AutoStartTrigger = "connect" | "status";

export interface AutoStartMatch {
  /** Dedup key stored on `Connector.lastAutoStartedScenarioKey` once the
   *  scenario fires, so a re-emitted trigger (status oscillation, CSMS
   *  reconnect) does not restart an unchanged scenario. */
  readonly key: string;
}

/**
 * Whether `definition` auto-starts on `trigger`. Shared by both runtimes
 * (the daemon's `CLIChargePointService` and the browser's
 * `LocalScenarioRuntime`) so they fire the same scenarios.
 *
 * A scenario auto-starts when it is enabled, its trigger is manual (or
 * absent), it has no StatusTrigger node (status-triggered scenarios are
 * driven by `ScenarioManager`'s `statusChange` matching instead), and its
 * Start node's `triggerOn` (default `connect`) matches — for `status`, the
 * connector must have reached the Start node's `targetStatus`.
 *
 * Callers still own the run-time gates: CP Available, nothing already
 * running on the connector, and the dedup key.
 */
export function matchAutoStart(
  definition: ScenarioDefinition,
  trigger: AutoStartTrigger,
  connectorStatus: OCPPStatus | null,
): AutoStartMatch | null {
  if (definition.enabled === false) return null;
  if (!Array.isArray(definition.nodes)) return null;
  if (
    definition.nodes.some((n) => n.type === ScenarioNodeType.STATUS_TRIGGER)
  ) {
    return null;
  }
  if (definition.trigger && definition.trigger.type !== "manual") return null;

  const startNode = definition.nodes.find(
    (n) => n.type === ScenarioNodeType.START,
  );
  const startData = startNode?.data as StartNodeData | undefined;
  const triggerOn = startData?.triggerOn ?? "connect";
  if (triggerOn !== trigger) return null;
  if (trigger === "status") {
    const target = startData?.targetStatus;
    if (!target || connectorStatus !== target) return null;
  }

  // Structural hash of the graph. `updatedAt` is deliberately left out: an
  // editor save bumps it without changing what the scenario does.
  const structuralKey = JSON.stringify({
    n: definition.nodes.map((n) => ({ id: n.id, type: n.type, data: n.data })),
    e: definition.edges.map((e) => ({ id: e.id, s: e.source, t: e.target })),
  });
  return {
    key: `${definition.id}:${structuralKey}:${triggerOn}:${startData?.targetStatus ?? ""}`,
  };
}

/**
 * Whether the connector's dedup key (`Connector.lastAutoStartedScenarioKey`)
 * was set by `definitionId`. A disabled definition releases only its own
 * key, so re-enabling it re-arms it — clearing any key would let a disabled
 * sibling re-arm an unrelated, unchanged scenario.
 */
export function isAutoStartKeyOf(
  key: string | null,
  definitionId: string,
): boolean {
  return key !== null && key.startsWith(`${definitionId}:`);
}
