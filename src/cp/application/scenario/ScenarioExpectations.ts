import {
  ScenarioNodeType,
  type CsmsCallTriggerNodeData,
  type ScenarioExpectation,
  type ScenarioNode,
  type StatusTriggerNodeData,
} from "./ScenarioTypes";

/**
 * #179 — derive the normalized {@link ScenarioExpectation} for a scenario node
 * that *parks* the execution waiting on an external condition, or `null` for
 * any node that does not wait.
 *
 * Pure function: it reads only the node and the target connector id, so it can
 * be called from the executor without touching runtime state. The waiting
 * nodes it covers are the five trigger types that block on a CSMS action, a
 * connector status, or a ReserveNow (mirroring the `onWaitFor*` callbacks in
 * ScenarioExecutor). The auto-increment MeterValue node also parks, but its
 * target depends on runtime state (meter-start offset / EV settings) and is an
 * active-work node rather than an external wait, so it is intentionally not
 * surfaced as an expectation here.
 *
 * @param node the node about to execute
 * @param connectorId the scenario's target connector (ScenarioDefinition.targetId)
 */
export function deriveExpectation(
  node: ScenarioNode,
  connectorId: number | undefined,
): ScenarioExpectation | null {
  const constraints = connectorId === undefined ? undefined : { connectorId };

  const timeoutMs = (
    nodeTimeoutSeconds: number | undefined,
  ): number | undefined =>
    nodeTimeoutSeconds && nodeTimeoutSeconds > 0
      ? nodeTimeoutSeconds * 1000
      : undefined;

  switch (node.type) {
    case ScenarioNodeType.REMOTE_START_TRIGGER:
      return {
        type: "ocpp_call",
        direction: "CSMS_TO_CP",
        action: "RemoteStartTransaction",
        constraints,
        timeoutMs: timeoutMs((node.data as { timeout?: number }).timeout),
        nodeId: node.id,
      };

    case ScenarioNodeType.REMOTE_STOP_TRIGGER:
      return {
        type: "ocpp_call",
        direction: "CSMS_TO_CP",
        action: "RemoteStopTransaction",
        constraints,
        timeoutMs: timeoutMs((node.data as { timeout?: number }).timeout),
        nodeId: node.id,
      };

    case ScenarioNodeType.CSMS_CALL_TRIGGER: {
      const data = node.data as CsmsCallTriggerNodeData;
      return {
        type: "ocpp_call",
        direction: "CSMS_TO_CP",
        action: data.action,
        constraints,
        timeoutMs: timeoutMs(data.timeout),
        nodeId: node.id,
      };
    }

    case ScenarioNodeType.STATUS_TRIGGER: {
      const data = node.data as StatusTriggerNodeData;
      return {
        type: "connector_status",
        targetStatus: data.targetStatus,
        constraints,
        timeoutMs: timeoutMs(data.timeout),
        nodeId: node.id,
      };
    }

    case ScenarioNodeType.RESERVATION_TRIGGER:
      return {
        type: "reservation",
        direction: "CSMS_TO_CP",
        action: "ReserveNow",
        constraints,
        timeoutMs: timeoutMs((node.data as { timeout?: number }).timeout),
        nodeId: node.id,
      };

    default:
      return null;
  }
}
