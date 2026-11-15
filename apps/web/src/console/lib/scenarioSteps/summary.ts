import {
  type CancelReservationNodeData,
  type CertQuirksNodeData,
  type ConfigSetNodeData,
  type ConnectionTriggerNodeData,
  type ConnectorPlugNodeData,
  type CsmsCallTriggerNodeData,
  type DataTransferNodeData,
  type ChoiceNodeData,
  type DelayNodeData,
  type NotifyNodeData,
  type SetStateNodeData,
  type SwitchNodeData,
  type InboundPolicyNodeData,
  type MeterValueNodeData,
  type NotificationNodeData,
  type CallResponseNodeData,
  type OcppCallNodeData,
  type UseBehaviorNodeData,
  type RemoteStartTriggerNodeData,
  type RemoteStopTriggerNodeData,
  type ReservationTriggerNodeData,
  type ReserveNowNodeData,
  type ResponseOverrideNodeData,
  type ScenarioNode,
  ScenarioNodeType,
  type StatusChangeNodeData,
  type StatusNotificationNodeData,
  type StatusTriggerNodeData,
  type TransactionNodeData,
  type UnlockOutcomeNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

/** A switch value on a card: a `$from` reference reads `$from path`, a
 *  constant as its JSON. */
export function summarizeValue(value: unknown): string {
  if (value && typeof value === "object" && "$from" in value) {
    return `$from ${String((value as { $from: unknown }).$from)}`;
  }
  return JSON.stringify(value) ?? "";
}

/**
 * One-line human summary of a step node's configuration, for a list-based
 * editor row. Falls back to the node's label for types without a bespoke
 * summary (and for START/END, which the list editor never renders as a
 * step but which may still flow through this function defensively).
 */
export function stepSummary(node: ScenarioNode): string {
  const label = node.data.label;

  switch (node.type) {
    case ScenarioNodeType.STATUS_CHANGE: {
      const d = node.data as StatusChangeNodeData;
      return `→ ${d.status}`;
    }
    case ScenarioNodeType.STATUS_NOTIFICATION: {
      const d = node.data as StatusNotificationNodeData;
      return `→ ${d.status}${d.errorCode ? ` · ${d.errorCode}` : ""}`;
    }
    case ScenarioNodeType.TRANSACTION: {
      const d = node.data as TransactionNodeData;
      return `${d.action}${d.tagId ? ` · tag ${d.tagId}` : ""}`;
    }
    case ScenarioNodeType.UNLOCK_OUTCOME: {
      const d = node.data as UnlockOutcomeNodeData;
      return d.outcome;
    }
    case ScenarioNodeType.METER_VALUE: {
      const d = node.data as MeterValueNodeData;
      if (d.useCurve) {
        return `curve · ${d.curvePoints?.length ?? 0} pts`;
      }
      return `${d.value} Wh${d.autoIncrement ? " · auto" : ""}`;
    }
    case ScenarioNodeType.CONNECTOR_PLUG: {
      const d = node.data as ConnectorPlugNodeData;
      return d.action;
    }
    case ScenarioNodeType.DELAY: {
      const d = node.data as DelayNodeData;
      return [
        `${d.delaySeconds} s`,
        d.until ? `until ${d.until}` : "",
        d.jitterSeconds ? `jitter ≤ ${d.jitterSeconds} s` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case ScenarioNodeType.REMOTE_START_TRIGGER: {
      const d = node.data as RemoteStartTriggerNodeData;
      return `wait RemoteStart${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.REMOTE_STOP_TRIGGER: {
      const d = node.data as RemoteStopTriggerNodeData;
      return `wait RemoteStop${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.STATUS_TRIGGER: {
      const d = node.data as StatusTriggerNodeData;
      return `wait ${d.targetStatus}${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.CSMS_CALL_TRIGGER: {
      const d = node.data as CsmsCallTriggerNodeData;
      return `wait ${d.action}${d.behavior === "replace" ? " · replace" : ""}${d.payload ? " · payload" : ""}${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.RESERVATION_TRIGGER: {
      const d = node.data as ReservationTriggerNodeData;
      return `wait ReserveNow${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.CONNECTION_TRIGGER: {
      const d = node.data as ConnectionTriggerNodeData;
      return `wait ${d.event}${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.RESERVE_NOW: {
      const d = node.data as ReserveNowNodeData;
      return `${d.idTag} · ${d.expiryMinutes}min`;
    }
    case ScenarioNodeType.CANCEL_RESERVATION: {
      const d = node.data as CancelReservationNodeData;
      return `#${d.reservationId}`;
    }
    case ScenarioNodeType.RESPONSE_OVERRIDE: {
      const d = node.data as ResponseOverrideNodeData;
      return `${d.action} → ${d.status}`;
    }
    case ScenarioNodeType.INBOUND_POLICY: {
      const d = node.data as InboundPolicyNodeData;
      if (d.policy === "answer") {
        return `${d.action} → normal`;
      } else if (d.policy === "callerror") {
        return `${d.action} → error(${d.errorCode ?? "NotImplemented"})`;
      } else {
        return `${d.action} → ignore`;
      }
    }
    case ScenarioNodeType.CERT_QUIRKS: {
      const d = node.data as CertQuirksNodeData;
      if (d.mode === "clear") {
        return "clear all quirks";
      } else {
        const parts: string[] = [];
        if (d.preset) parts.push(`preset: ${d.preset}`);
        if (d.csrKeyAlgorithm) parts.push(`CSR: ${d.csrKeyAlgorithm}`);
        if (d.csrPemLineEndings)
          parts.push(`PEM: ${d.csrPemLineEndings.toUpperCase()}`);
        return parts.length > 0 ? parts.join(" · ") : "set quirks";
      }
    }
    case ScenarioNodeType.CONFIG_SET: {
      const d = node.data as ConfigSetNodeData;
      return `${d.key} = ${d.value}`;
    }
    case ScenarioNodeType.DATA_TRANSFER: {
      const d = node.data as DataTransferNodeData;
      return d.vendorId;
    }
    case ScenarioNodeType.NOTIFICATION: {
      const d = node.data as NotificationNodeData;
      return d.messageType;
    }
    case ScenarioNodeType.OCPP_CALL: {
      const d = node.data as OcppCallNodeData;
      return d.skipValidation ? `${d.action} (unvalidated)` : d.action;
    }
    case ScenarioNodeType.CALL_RESPONSE: {
      const d = node.data as CallResponseNodeData;
      const what =
        d.kind === "error"
          ? `CALLERROR ${d.errorCode ?? "GenericError"}`
          : d.kind === "none"
            ? "no answer"
            : d.kind === "accepted" || d.kind === "rejected"
              ? d.kind
              : "CALLRESULT";
      return d.skipValidation ? `${what} (unvalidated)` : what;
    }
    case ScenarioNodeType.USE_BEHAVIOR: {
      const d = node.data as UseBehaviorNodeData;
      return d.behaviorId;
    }
    case ScenarioNodeType.NOTIFY: {
      const d = node.data as NotifyNodeData;
      return `${d.kind} ${d.status}`;
    }
    case ScenarioNodeType.SWITCH: {
      const d = node.data as SwitchNodeData;
      return `${summarizeValue(d.value)} · ${d.cases?.length ?? 0} cases`;
    }
    case ScenarioNodeType.CHOICE: {
      const d = node.data as ChoiceNodeData;
      return `${d.options?.length ?? 0} options`;
    }
    case ScenarioNodeType.SET_STATE: {
      const d = node.data as SetStateNodeData;
      return `${d.key} = ${JSON.stringify(d.value)}`;
    }
    default:
      return label;
  }
}
