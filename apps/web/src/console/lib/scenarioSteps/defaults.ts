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
  type AnyScenarioNodeType,
  type JoinNodeData,
  ScenarioFlowNodeType,
  type ScenarioNode,
  ScenarioNodeType,
  type StatusChangeNodeData,
  type StatusNotificationNodeData,
  type StatusTriggerNodeData,
  type TransactionNodeData,
  type UnlockOutcomeNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";

/**
 * Default node data per `ScenarioNodeType`, mirroring the palette of
 * the retired ReactFlow editor for every type it offered. RESERVE_NOW / CANCEL_RESERVATION aren't in that palette (its
 * switch falls through to a generic "Unknown" node for them); their
 * defaults here were derived from `ReserveNowNodeData` /
 * `CancelReservationNodeData`'s field shapes instead. RESERVATION_TRIGGER's
 * default matches the `{ label: "Wait for ReserveNow", timeout: 0 }` shape
 * already used by the cert16 reservation templates
 * (packages/core/src/utils/scenarios/cert16-reservation-basic.json).
 */
export function createDefaultNode(type: AnyScenarioNodeType): ScenarioNode {
  const id = crypto.randomUUID();
  const position = { x: 0, y: 0 };

  switch (type) {
    case ScenarioNodeType.STATUS_CHANGE:
      return {
        id,
        type,
        position,
        data: {
          label: "Status Change",
          status: OCPPStatus.Available,
        } satisfies StatusChangeNodeData,
      };
    case ScenarioNodeType.TRANSACTION:
      return {
        id,
        type,
        position,
        data: {
          label: "Transaction",
          action: "start",
          tagId: "123456",
        } satisfies TransactionNodeData,
      };
    case ScenarioNodeType.METER_VALUE:
      return {
        id,
        type,
        position,
        data: {
          label: "Meter Value",
          value: 10,
          sendMessage: true,
        } satisfies MeterValueNodeData,
      };
    case ScenarioNodeType.DELAY:
      return {
        id,
        type,
        position,
        data: { label: "Delay", delaySeconds: 5 } satisfies DelayNodeData,
      };
    case ScenarioNodeType.NOTIFICATION:
      return {
        id,
        type,
        position,
        data: {
          label: "Notification",
          messageType: "Heartbeat",
          payload: {},
        } satisfies NotificationNodeData,
      };
    case ScenarioNodeType.CONNECTOR_PLUG:
      return {
        id,
        type,
        position,
        data: {
          label: "Connector Plug",
          action: "plugin",
        } satisfies ConnectorPlugNodeData,
      };
    case ScenarioNodeType.REMOTE_START_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for RemoteStart",
          timeout: 0,
        } satisfies RemoteStartTriggerNodeData,
      };
    case ScenarioNodeType.REMOTE_STOP_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for RemoteStop",
          timeout: 0,
        } satisfies RemoteStopTriggerNodeData,
      };
    case ScenarioNodeType.STATUS_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for Status",
          targetStatus: OCPPStatus.Charging,
          timeout: 0,
        } satisfies StatusTriggerNodeData,
      };
    case ScenarioNodeType.RESERVE_NOW:
      return {
        id,
        type,
        position,
        data: {
          label: "Reserve Now",
          expiryMinutes: 30,
          idTag: "123456",
        } satisfies ReserveNowNodeData,
      };
    case ScenarioNodeType.CANCEL_RESERVATION:
      return {
        id,
        type,
        position,
        data: {
          label: "Cancel Reservation",
          reservationId: 1,
        } satisfies CancelReservationNodeData,
      };
    case ScenarioNodeType.RESERVATION_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for ReserveNow",
          timeout: 0,
        } satisfies ReservationTriggerNodeData,
      };
    case ScenarioNodeType.STATUS_NOTIFICATION:
      return {
        id,
        type,
        position,
        data: {
          label: "Status Notification",
          status: OCPPStatus.Faulted,
          errorCode: "InternalError",
        } satisfies StatusNotificationNodeData,
      };
    case ScenarioNodeType.UNLOCK_OUTCOME:
      return {
        id,
        type,
        position,
        data: {
          label: "Unlock Outcome",
          outcome: "Unlocked",
        } satisfies UnlockOutcomeNodeData,
      };
    case ScenarioNodeType.CONFIG_SET:
      return {
        id,
        type,
        position,
        data: {
          label: "ConfigSet",
          key: "MeterValueSampleInterval",
          value: "30",
        } satisfies ConfigSetNodeData,
      };
    case ScenarioNodeType.DATA_TRANSFER:
      return {
        id,
        type,
        position,
        data: {
          label: "DataTransfer",
          vendorId: "com.example",
        } satisfies DataTransferNodeData,
      };
    case ScenarioNodeType.OCPP_CALL:
      return {
        id,
        type,
        position,
        data: {
          label: "OCPP call",
          action: "Heartbeat",
          payload: {},
        } satisfies OcppCallNodeData,
      };
    case ScenarioNodeType.CALL_RESPONSE:
      return {
        id,
        type,
        position,
        data: {
          label: "Call response",
          kind: "result",
          payload: {},
        } satisfies CallResponseNodeData,
      };
    case ScenarioNodeType.USE_BEHAVIOR:
      return {
        id,
        type,
        position,
        data: {
          label: "Use behavior",
          behaviorId: "",
        } satisfies UseBehaviorNodeData,
      };
    case ScenarioNodeType.NOTIFY:
      return {
        id,
        type,
        position,
        data: {
          label: "Notify",
          kind: "firmwareStatus",
          status: "Idle",
        } satisfies NotifyNodeData,
      };
    case ScenarioNodeType.SWITCH:
      return {
        id,
        type,
        position,
        data: {
          label: "Switch",
          value: { $from: "state.mode" },
          cases: ["a", "b"],
        } satisfies SwitchNodeData,
      };
    case ScenarioNodeType.CHOICE:
      return {
        id,
        type,
        position,
        data: { label: "Choice", options: [{}, {}] } satisfies ChoiceNodeData,
      };
    case ScenarioNodeType.SET_STATE:
      return {
        id,
        type,
        position,
        data: {
          label: "Set state",
          key: "mode",
          value: "a",
        } satisfies SetStateNodeData,
      };
    case ScenarioFlowNodeType.PARALLEL:
      return { id, type, position, data: { label: "Parallel" } };
    case ScenarioFlowNodeType.JOIN:
      return {
        id,
        type,
        position,
        data: { label: "Join", mode: "all" } satisfies JoinNodeData,
      };
    case ScenarioNodeType.CSMS_CALL_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for CSMS Call",
          action: "Reset",
          timeout: 0,
        } satisfies CsmsCallTriggerNodeData,
      };
    case ScenarioNodeType.RESPONSE_OVERRIDE:
      return {
        id,
        type,
        position,
        data: {
          label: "Response Override",
          action: "RemoteStartTransaction",
          status: "Rejected",
        } satisfies ResponseOverrideNodeData,
      };
    case ScenarioNodeType.INBOUND_POLICY:
      return {
        id,
        type,
        position,
        data: {
          label: "Inbound Policy",
          action: "Reset",
          policy: "callerror",
          errorCode: "NotImplemented",
          errorDescription: "",
        } satisfies InboundPolicyNodeData,
      };
    case ScenarioNodeType.CERT_QUIRKS:
      return {
        id,
        type,
        position,
        data: {
          label: "Certificate Quirks",
          mode: "set",
        } satisfies CertQuirksNodeData,
      };
    case ScenarioNodeType.CONNECTION_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for Disconnect",
          event: "disconnected",
          timeout: 0,
        } satisfies ConnectionTriggerNodeData,
      };
    case ScenarioNodeType.START:
      return {
        id,
        type,
        position,
        data: { label: "Start", triggerOn: "connect" },
      };
    case ScenarioNodeType.END:
      return {
        id,
        type,
        position,
        data: { label: "End" },
      };
    default: {
      const exhaustiveCheck: never = type;
      throw new Error(`Unhandled ScenarioNodeType: ${String(exhaustiveCheck)}`);
    }
  }
}
