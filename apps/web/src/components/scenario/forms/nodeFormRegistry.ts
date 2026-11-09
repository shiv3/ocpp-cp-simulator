import {
  type BaseNodeData,
  type CancelReservationNodeData,
  CERT_SIGNATURE_ALGORITHMS,
  type CertQuirksNodeData,
  type AnyScenarioNodeType,
  type ConfigSetNodeData,
  type ConnectionTriggerNodeData,
  type ConnectorPlugNodeData,
  CSMS_CALL_TRIGGER_ACTIONS,
  type CsmsCallTriggerNodeData,
  type DataTransferNodeData,
  type CallResponseNodeData,
  type CallResponseSpec,
  type OcppCallNodeData,
  type UseBehaviorNodeData,
  type ChoiceNodeData,
  type DelayNodeData,
  type JoinNodeData,
  ScenarioFlowNodeType,
  NOTIFY_KINDS,
  type NotifyNodeData,
  type SetStateNodeData,
  type SwitchNodeData,
  INBOUND_POLICY_ACTIONS,
  INBOUND_POLICY_ERROR_CODES,
  type InboundPolicyNodeData,
  type MeterValueNodeData,
  type NotificationNodeData,
  type RemoteStartTriggerNodeData,
  type RemoteStopTriggerNodeData,
  RESPONSE_OVERRIDE_ACTIONS,
  RESPONSE_OVERRIDE_STATUSES,
  type ResponseOverrideNodeData,
  type ReservationTriggerNodeData,
  type ReserveNowNodeData,
  type ScenarioNodeData,
  ScenarioNodeType,
  type StartNodeData,
  type StatusChangeNodeData,
  type StatusNotificationNodeData,
  type StatusTriggerNodeData,
  type TransactionNodeData,
  type UnlockOutcomeNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type { MessageKey } from "../../../i18n";
import type { CurvePoint } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import CancelReservationForm from "./CancelReservationForm";
import CertQuirksForm from "./CertQuirksForm";
import ConfigSetForm from "./ConfigSetForm";
import ConnectionTriggerForm from "./ConnectionTriggerForm";
import ConnectorPlugForm from "./ConnectorPlugForm";
import CsmsCallTriggerForm from "./CsmsCallTriggerForm";
import DataTransferForm from "./DataTransferForm";
import ChoiceForm from "./ChoiceForm";
import DelayForm from "./DelayForm";
import NotifyForm from "./NotifyForm";
import { NOTIFY_STATUSES } from "./notifyStatuses";
import SetStateForm from "./SetStateForm";
import SwitchForm from "./SwitchForm";
import EndForm from "./EndForm";
import JoinForm from "./JoinForm";
import InboundPolicyForm from "./InboundPolicyForm";
import MeterValueForm from "./MeterValueForm";
import NotificationForm from "./NotificationForm";
import OcppCallForm from "./OcppCallForm";
import CallResponseForm from "./CallResponseForm";
import UseBehaviorForm from "./UseBehaviorForm";
import RemoteStartTriggerForm from "./RemoteStartTriggerForm";
import RemoteStopTriggerForm from "./RemoteStopTriggerForm";
import ResponseOverrideForm from "./ResponseOverrideForm";
import ReservationTriggerForm from "./ReservationTriggerForm";
import ReserveNowForm from "./ReserveNowForm";
import StartForm from "./StartForm";
import StatusChangeForm from "./StatusChangeForm";
import StatusNotificationForm from "./StatusNotificationForm";
import StatusTriggerForm from "./StatusTriggerForm";
import TransactionForm from "./TransactionForm";
import UnlockOutcomeForm from "./UnlockOutcomeForm";
import type { NodeFormComponent, NodeFormData } from "./types";

export interface NodeFormEntry<TFormData extends NodeFormData = NodeFormData> {
  /** Message key of the node type's display name. */
  title: MessageKey;
  Component: NodeFormComponent<TFormData>;
  nodeDataToForm: (nodeData: ScenarioNodeData) => TFormData;
  formToNodeData: (formData: TFormData) => ScenarioNodeData;
}

const OCPP_STATUS_VALUES = new Set<string>(Object.values(OCPPStatus));

function compactDefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asOcppStatus(value: unknown, fallback: OCPPStatus): OCPPStatus {
  return typeof value === "string" && OCPP_STATUS_VALUES.has(value)
    ? (value as OCPPStatus)
    : fallback;
}

const CSMS_CALL_TRIGGER_ACTIONS_SET = new Set<string>(
  CSMS_CALL_TRIGGER_ACTIONS,
);

function asCsmsCallTriggerAction(
  value: unknown,
): (typeof CSMS_CALL_TRIGGER_ACTIONS)[number] {
  return typeof value === "string" && CSMS_CALL_TRIGGER_ACTIONS_SET.has(value)
    ? (value as (typeof CSMS_CALL_TRIGGER_ACTIONS)[number])
    : "Reset";
}

/** #240: keep only a plain-object payload condition; anything else
 *  (unparsed textarea string, array) is dropped on save. */
function asPayloadCondition(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const RESPONSE_OVERRIDE_ACTIONS_SET = new Set<string>(
  RESPONSE_OVERRIDE_ACTIONS,
);

function asResponseOverrideAction(
  value: unknown,
): (typeof RESPONSE_OVERRIDE_ACTIONS)[number] {
  return typeof value === "string" && RESPONSE_OVERRIDE_ACTIONS_SET.has(value)
    ? (value as (typeof RESPONSE_OVERRIDE_ACTIONS)[number])
    : "RemoteStartTransaction";
}

function asResponseOverrideStatus(
  value: unknown,
  action: (typeof RESPONSE_OVERRIDE_ACTIONS)[number],
): string {
  const validStatuses = RESPONSE_OVERRIDE_STATUSES[action];
  return typeof value === "string" && validStatuses.includes(value)
    ? value
    : validStatuses[0];
}

const INBOUND_POLICY_ACTIONS_SET = new Set<string>(INBOUND_POLICY_ACTIONS);
const CERT_SIGNATURE_ALGORITHMS_SET = new Set<string>(
  CERT_SIGNATURE_ALGORITHMS,
);
const INBOUND_POLICY_ERROR_CODES_SET = new Set<string>(
  INBOUND_POLICY_ERROR_CODES,
);

function asInboundPolicyAction(
  value: unknown,
): (typeof INBOUND_POLICY_ACTIONS)[number] {
  return typeof value === "string" && INBOUND_POLICY_ACTIONS_SET.has(value)
    ? (value as (typeof INBOUND_POLICY_ACTIONS)[number])
    : "Reset";
}

function asInboundPolicyMode(
  value: unknown,
): "answer" | "callerror" | "ignore" {
  return value === "answer" || value === "ignore" ? value : "callerror";
}

/** Imported/programmatic node data can carry any string here, and the
 *  transport casts the code straight into a CALLERROR frame — so an
 *  unknown value must not survive conversion. Absent stays absent (the
 *  runtime applies its own NotImplemented default); present-but-invalid
 *  normalizes to NotImplemented, mirroring asInboundPolicyAction. */
function asInboundPolicyErrorCode(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && INBOUND_POLICY_ERROR_CODES_SET.has(value)
    ? value
    : "NotImplemented";
}

function baseToForm(nodeData: ScenarioNodeData): NodeFormData {
  return compactDefined({
    label: stringValue(nodeData.label),
    description: optionalString(nodeData.description),
  });
}

function baseFromForm(formData: NodeFormData): BaseNodeData {
  return compactDefined({
    label: stringValue(formData.label),
    description: optionalString(formData.description),
  });
}

function transactionAction(value: unknown): TransactionNodeData["action"] {
  return value === "stop" ? "stop" : "start";
}

function connectorAction(value: unknown): ConnectorPlugNodeData["action"] {
  return value === "plugout" ? "plugout" : "plugin";
}

function stopMode(value: unknown): MeterValueNodeData["stopMode"] | undefined {
  return value === "manual" || value === "evSettings" ? value : undefined;
}

function triggerOn(value: unknown): StartNodeData["triggerOn"] | undefined {
  return value === "connect" || value === "status" ? value : undefined;
}

function unlockOutcome(value: unknown): UnlockOutcomeNodeData["outcome"] {
  return value === "UnlockFailed" || value === "NotSupported"
    ? value
    : "Unlocked";
}

function curvePoints(value: unknown): CurvePoint[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const points = value
    .map((point) => {
      if (
        typeof point !== "object" ||
        point === null ||
        !("time" in point) ||
        !("value" in point)
      ) {
        return undefined;
      }

      const time = (point as { time: unknown }).time;
      const pointValue = (point as { value: unknown }).value;

      return typeof time === "number" &&
        Number.isFinite(time) &&
        typeof pointValue === "number" &&
        Number.isFinite(pointValue)
        ? { time, value: pointValue }
        : undefined;
    })
    .filter((point): point is CurvePoint => point !== undefined);

  return points.length > 0 ? points : undefined;
}

function payloadValue(value: unknown): Record<string, unknown> | string {
  return typeof value === "string" ||
    (typeof value === "object" && value !== null && !Array.isArray(value))
    ? (value as Record<string, unknown> | string)
    : {};
}

function statusChangeNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    status: asOcppStatus(
      (nodeData as Partial<StatusChangeNodeData>).status,
      OCPPStatus.Available,
    ),
  });
}

function statusChangeFormToNodeData(
  formData: NodeFormData,
): StatusChangeNodeData {
  return {
    ...baseFromForm(formData),
    status: asOcppStatus(formData.status, OCPPStatus.Available),
  };
}

function transactionNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<TransactionNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    action: transactionAction(data.action),
    tagId: optionalString(data.tagId),
    batteryCapacityKwh: optionalNumber(data.batteryCapacityKwh),
    initialSoc: optionalNumber(data.initialSoc),
  });
}

function transactionFormToNodeData(
  formData: NodeFormData,
): TransactionNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    action: transactionAction(formData.action),
    tagId: optionalString(formData.tagId),
    batteryCapacityKwh: optionalNumber(formData.batteryCapacityKwh),
    initialSoc: optionalNumber(formData.initialSoc),
  }) as TransactionNodeData;
}

export function meterValueNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  const data = nodeData as Partial<MeterValueNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    value: numberValue(data.value),
    sendMessage: booleanValue(data.sendMessage),
    autoIncrement: optionalBoolean(data.autoIncrement),
    outputKw: optionalNumber(data.outputKw),
    maxChargeKwh: optionalNumber(data.maxChargeKwh),
    incrementInterval: optionalNumber(data.incrementInterval),
    incrementAmount: optionalNumber(data.incrementAmount),
    stopMode: stopMode(data.stopMode),
    maxTime: optionalNumber(data.maxTime),
    maxValue: optionalNumber(data.maxValue),
    useCurve: optionalBoolean(data.useCurve),
    curvePoints: curvePoints(data.curvePoints),
    autoCalculateInterval: optionalBoolean(data.autoCalculateInterval),
  });
}

export function meterValueFormToNodeData(
  formData: NodeFormData,
): MeterValueNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    value: numberValue(formData.value),
    sendMessage: booleanValue(formData.sendMessage),
    autoIncrement: optionalBoolean(formData.autoIncrement),
    outputKw: optionalNumber(formData.outputKw),
    maxChargeKwh: optionalNumber(formData.maxChargeKwh),
    incrementInterval: optionalNumber(formData.incrementInterval),
    incrementAmount: optionalNumber(formData.incrementAmount),
    stopMode: stopMode(formData.stopMode),
    maxTime: optionalNumber(formData.maxTime),
    maxValue: optionalNumber(formData.maxValue),
    useCurve: optionalBoolean(formData.useCurve),
    curvePoints: curvePoints(formData.curvePoints),
    autoCalculateInterval: optionalBoolean(formData.autoCalculateInterval),
  }) as MeterValueNodeData;
}

/** Schema 1.6 (#654): `until` (empty text is absent) and a non-negative
 *  `jitterSeconds`. */
function delayExtras(source: Partial<DelayNodeData>) {
  const jitter = optionalNumber(source.jitterSeconds);
  return {
    until:
      typeof source.until === "string" && source.until !== ""
        ? source.until
        : undefined,
    jitterSeconds: jitter !== undefined && jitter >= 0 ? jitter : undefined,
  };
}

function delayNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    delaySeconds: numberValue(
      (nodeData as Partial<DelayNodeData>).delaySeconds,
    ),
    ...delayExtras(nodeData as Partial<DelayNodeData>),
  });
}

function delayFormToNodeData(formData: NodeFormData): DelayNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    delaySeconds: numberValue(formData.delaySeconds),
    ...delayExtras(formData as Partial<DelayNodeData>),
  }) as DelayNodeData;
}

function notificationNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<NotificationNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    messageType: stringValue(data.messageType),
    payload: payloadValue(data.payload),
  });
}

function notificationFormToNodeData(
  formData: NodeFormData,
): NotificationNodeData {
  return {
    ...baseFromForm(formData),
    messageType: stringValue(formData.messageType),
    payload: payloadValue(formData.payload) as Record<string, unknown>,
  };
}

function connectorPlugNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    action: connectorAction(
      (nodeData as Partial<ConnectorPlugNodeData>).action,
    ),
  });
}

function connectorPlugFormToNodeData(
  formData: NodeFormData,
): ConnectorPlugNodeData {
  return {
    ...baseFromForm(formData),
    action: connectorAction(formData.action),
  };
}

function remoteStartTriggerNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    timeout: optionalNumber(
      (nodeData as Partial<RemoteStartTriggerNodeData>).timeout,
    ),
  });
}

function remoteStartTriggerFormToNodeData(
  formData: NodeFormData,
): RemoteStartTriggerNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    timeout: optionalNumber(formData.timeout),
  });
}

function remoteStopTriggerNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    timeout: optionalNumber(
      (nodeData as Partial<RemoteStopTriggerNodeData>).timeout,
    ),
  });
}

function remoteStopTriggerFormToNodeData(
  formData: NodeFormData,
): RemoteStopTriggerNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    timeout: optionalNumber(formData.timeout),
  });
}

function statusTriggerNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<StatusTriggerNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    targetStatus: asOcppStatus(data.targetStatus, OCPPStatus.Charging),
    timeout: optionalNumber(data.timeout),
  });
}

function statusTriggerFormToNodeData(
  formData: NodeFormData,
): StatusTriggerNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    targetStatus: asOcppStatus(formData.targetStatus, OCPPStatus.Charging),
    timeout: optionalNumber(formData.timeout),
  }) as StatusTriggerNodeData;
}

function reserveNowNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<ReserveNowNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    expiryMinutes: numberValue(data.expiryMinutes),
    idTag: stringValue(data.idTag),
    parentIdTag: optionalString(data.parentIdTag),
    reservationId: optionalNumber(data.reservationId),
  });
}

function reserveNowFormToNodeData(formData: NodeFormData): ReserveNowNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    expiryMinutes: numberValue(formData.expiryMinutes),
    idTag: stringValue(formData.idTag),
    parentIdTag: optionalString(formData.parentIdTag),
    reservationId: optionalNumber(formData.reservationId),
  }) as ReserveNowNodeData;
}

function cancelReservationNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    reservationId: numberValue(
      (nodeData as Partial<CancelReservationNodeData>).reservationId,
    ),
  });
}

function cancelReservationFormToNodeData(
  formData: NodeFormData,
): CancelReservationNodeData {
  return {
    ...baseFromForm(formData),
    reservationId: numberValue(formData.reservationId),
  };
}

function reservationTriggerNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    timeout: optionalNumber(
      (nodeData as Partial<ReservationTriggerNodeData>).timeout,
    ),
  });
}

function reservationTriggerFormToNodeData(
  formData: NodeFormData,
): ReservationTriggerNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    timeout: optionalNumber(formData.timeout),
  });
}

function startNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<StartNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    triggerOn: triggerOn(data.triggerOn),
    targetStatus: asOcppStatus(data.targetStatus, OCPPStatus.Available),
  });
}

function startFormToNodeData(formData: NodeFormData): StartNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    triggerOn: triggerOn(formData.triggerOn),
    targetStatus:
      formData.targetStatus === undefined
        ? undefined
        : asOcppStatus(formData.targetStatus, OCPPStatus.Available),
  }) as StartNodeData;
}

function endNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  return baseToForm(nodeData);
}

function endFormToNodeData(formData: NodeFormData): BaseNodeData {
  return baseFromForm(formData);
}

function joinNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<JoinNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    mode: data.mode === "any" ? "any" : "all",
  });
}

function joinFormToNodeData(formData: NodeFormData): JoinNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    mode: formData.mode === "any" ? ("any" as const) : undefined,
  }) as JoinNodeData;
}

function statusNotificationNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  const data = nodeData as Partial<StatusNotificationNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    status: asOcppStatus(data.status, OCPPStatus.Faulted),
    errorCode: optionalString(data.errorCode),
    info: optionalString(data.info),
    vendorErrorCode: optionalString(data.vendorErrorCode),
    vendorId: optionalString(data.vendorId),
    connectorId: optionalNumber(data.connectorId),
  });
}

function statusNotificationFormToNodeData(
  formData: NodeFormData,
): StatusNotificationNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    status: asOcppStatus(formData.status, OCPPStatus.Faulted),
    errorCode: optionalString(formData.errorCode),
    info: optionalString(formData.info),
    vendorErrorCode: optionalString(formData.vendorErrorCode),
    vendorId: optionalString(formData.vendorId),
    connectorId: optionalNumber(formData.connectorId),
  }) as StatusNotificationNodeData;
}

function unlockOutcomeNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    outcome: unlockOutcome(
      (nodeData as Partial<UnlockOutcomeNodeData>).outcome,
    ),
  });
}

function unlockOutcomeFormToNodeData(
  formData: NodeFormData,
): UnlockOutcomeNodeData {
  return {
    ...baseFromForm(formData),
    outcome: unlockOutcome(formData.outcome),
  };
}

function configSetNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<ConfigSetNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    key: stringValue(data.key),
    value: stringValue(data.value),
  });
}

function configSetFormToNodeData(formData: NodeFormData): ConfigSetNodeData {
  return {
    ...baseFromForm(formData),
    key: stringValue(formData.key),
    value: stringValue(formData.value),
  };
}

function dataTransferNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<DataTransferNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    vendorId: stringValue(data.vendorId),
    messageId: optionalString(data.messageId),
    data: optionalString(data.data),
  });
}

function dataTransferFormToNodeData(
  formData: NodeFormData,
): DataTransferNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    vendorId: stringValue(formData.vendorId),
    messageId: optionalString(formData.messageId),
    data: optionalString(formData.data),
  }) as DataTransferNodeData;
}

/** An ocppCall payload as saved (#389): an object as is; anything else as
 *  the text that was authored, never replaced by `{}` — the run then refuses
 *  the step instead of silently sending a different, valid payload. */
function ocppCallPayload(value: unknown): Record<string, unknown> | string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return JSON.stringify(value) ?? "";
}

function ocppCallNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<OcppCallNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    action: stringValue(data.action),
    payload: ocppCallPayload(data.payload),
    skipValidation: optionalBoolean(data.skipValidation),
    applyResponse: optionalBoolean(data.applyResponse),
  });
}

function ocppCallFormToNodeData(formData: NodeFormData): OcppCallNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    action: stringValue(formData.action),
    payload: ocppCallPayload(formData.payload) as Record<string, unknown>,
    skipValidation: optionalBoolean(formData.skipValidation),
    applyResponse: optionalBoolean(formData.applyResponse),
  }) as OcppCallNodeData;
}

const CALL_RESPONSE_KINDS = new Set<string>([
  "result",
  "error",
  "none",
  "accepted",
  "rejected",
]);

/** The fields of a CallResponseSpec as the form edits them and as saved. A
 *  payload that is not an object is kept as typed (see ocppCallPayload). */
function callResponseSpecFields(source: Record<string, unknown>) {
  const kind = CALL_RESPONSE_KINDS.has(source.kind as string)
    ? (source.kind as CallResponseSpec["kind"])
    : "result";
  // Schema 1.6 (#654): accepted / rejected carry nothing else.
  if (kind === "accepted" || kind === "rejected") {
    return {
      kind,
      payload: undefined,
      errorCode: undefined,
      errorDescription: undefined,
    };
  }
  return {
    kind,
    payload:
      source.payload === undefined
        ? undefined
        : (ocppCallPayload(source.payload) as Record<string, unknown>),
    errorCode: optionalString(source.errorCode),
    errorDescription: optionalString(source.errorDescription),
  };
}

function asCallResponseSpec(value: unknown): CallResponseSpec | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return compactDefined(
    callResponseSpecFields(value as Record<string, unknown>),
  );
}

function callResponseSkipValidation(
  source: Record<string, unknown>,
): boolean | undefined {
  return source.kind === "accepted" || source.kind === "rejected"
    ? undefined
    : optionalBoolean(source.skipValidation);
}

function callResponseNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    ...callResponseSpecFields(nodeData as Record<string, unknown>),
    skipValidation: callResponseSkipValidation(
      nodeData as Record<string, unknown>,
    ),
  });
}

function callResponseFormToNodeData(
  formData: NodeFormData,
): CallResponseNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    ...callResponseSpecFields(formData),
    skipValidation: callResponseSkipValidation(formData),
  }) as CallResponseNodeData;
}

const NOTIFY_KINDS_SET = new Set<string>(NOTIFY_KINDS);

function asNotifyKind(value: unknown): NotifyNodeData["kind"] {
  return NOTIFY_KINDS_SET.has(value as string)
    ? (value as NotifyNodeData["kind"])
    : "firmwareStatus";
}

/** A `{ "$from": "..." }` reference as written, or undefined. */
function asFromReference(value: unknown): { $from: string } | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { $from?: unknown }).$from === "string"
    ? { $from: (value as { $from: string }).$from }
    : undefined;
}

function notifyFields(source: Record<string, unknown>) {
  const kind = asNotifyKind(source.kind);
  const status =
    typeof source.status === "string"
      ? source.status
      : NOTIFY_STATUSES[kind][0];
  return compactDefined({
    kind,
    status,
    requestId:
      optionalNumber(source.requestId) ?? asFromReference(source.requestId),
  });
}

function notifyNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  return {
    ...baseToForm(nodeData),
    ...notifyFields(nodeData as Record<string, unknown>),
  };
}

function notifyFormToNodeData(formData: NodeFormData): NotifyNodeData {
  return {
    ...baseFromForm(formData),
    ...notifyFields(formData),
  } as NotifyNodeData;
}

function switchNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<SwitchNodeData>;
  return {
    ...baseToForm(nodeData),
    value: data.value ?? null,
    // As the file has them, a list or not: the form says when they are
    // not and changes them only on the user's word.
    cases: data.cases,
  };
}

function switchFormToNodeData(formData: NodeFormData): SwitchNodeData {
  return {
    ...baseFromForm(formData),
    value: formData.value ?? null,
    cases: formData.cases as unknown[],
  };
}

/** Keeps the options as authored: a finite weight and a label. An entry
 *  that is not an object (null, a number) stays as it is: the executor
 *  draws it with weight 1, and the form shows it as such. */
function choiceOptions(value: unknown): ChoiceNodeData["options"] {
  if (!Array.isArray(value)) return [];
  return value.map((option) => {
    if (
      typeof option !== "object" ||
      option === null ||
      Array.isArray(option)
    ) {
      return option as ChoiceNodeData["options"][number];
    }
    const o = option as {
      weight?: unknown;
      label?: unknown;
    };
    const weight = optionalNumber(o.weight);
    return compactDefined({
      weight,
      label:
        typeof o.label === "string" && o.label !== "" ? o.label : undefined,
    });
  });
}

function choiceNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  return {
    ...baseToForm(nodeData),
    options: choiceOptions((nodeData as Partial<ChoiceNodeData>).options),
  };
}

function choiceFormToNodeData(formData: NodeFormData): ChoiceNodeData {
  return {
    ...baseFromForm(formData),
    options: choiceOptions(formData.options),
  };
}

function setStateNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<SetStateNodeData>;
  return {
    ...baseToForm(nodeData),
    key: stringValue(data.key),
    value: data.value ?? null,
  };
}

function setStateFormToNodeData(formData: NodeFormData): SetStateNodeData {
  return {
    ...baseFromForm(formData),
    key: stringValue(formData.key),
    value: formData.value ?? null,
  };
}

function useBehaviorNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  return {
    ...baseToForm(nodeData),
    behaviorId: stringValue(
      (nodeData as Partial<UseBehaviorNodeData>).behaviorId,
    ),
    ...compactDefined({
      mode: (nodeData as Partial<UseBehaviorNodeData>).mode,
      params: (nodeData as Partial<UseBehaviorNodeData>).params,
    }),
  };
}

function useBehaviorFormToNodeData(
  formData: NodeFormData,
): UseBehaviorNodeData {
  return {
    ...baseFromForm(formData),
    behaviorId: stringValue(formData.behaviorId),
    // "use" is the default: only "disable" is written, and a disabled node
    // carries no params.
    ...(formData.mode === "disable"
      ? { mode: "disable" as const }
      : compactDefined({
          params:
            typeof formData.params === "object" &&
            formData.params !== null &&
            !Array.isArray(formData.params)
              ? (formData.params as Record<string, unknown>)
              : undefined,
        })),
  };
}

function csmsCallTriggerNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    action: asCsmsCallTriggerAction(
      (nodeData as Partial<CsmsCallTriggerNodeData>).action,
    ),
    timeout: optionalNumber(
      (nodeData as Partial<CsmsCallTriggerNodeData>).timeout,
    ),
    payload: (nodeData as Partial<CsmsCallTriggerNodeData>).payload,
    behavior:
      (nodeData as Partial<CsmsCallTriggerNodeData>).behavior === "replace"
        ? "replace"
        : undefined,
    onBusy:
      (nodeData as Partial<CsmsCallTriggerNodeData>).behavior === "replace"
        ? asCallResponseSpec(
            (nodeData as Partial<CsmsCallTriggerNodeData>).onBusy,
          )
        : undefined,
  });
}

function csmsCallTriggerFormToNodeData(
  formData: NodeFormData,
): CsmsCallTriggerNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    action: asCsmsCallTriggerAction(formData.action),
    timeout: optionalNumber(formData.timeout),
    payload: asPayloadCondition(formData.payload),
    // `observe` is the default and stays absent from saved scenarios.
    behavior: formData.behavior === "replace" ? "replace" : undefined,
    onBusy:
      formData.behavior === "replace"
        ? asCallResponseSpec(formData.onBusy)
        : undefined,
  }) as CsmsCallTriggerNodeData;
}

function responseOverrideNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  const action = asResponseOverrideAction(
    (nodeData as Partial<ResponseOverrideNodeData>).action,
  );
  return compactDefined({
    ...baseToForm(nodeData),
    action,
    status: asResponseOverrideStatus(
      (nodeData as Partial<ResponseOverrideNodeData>).status,
      action,
    ),
  });
}

function responseOverrideFormToNodeData(
  formData: NodeFormData,
): ResponseOverrideNodeData {
  const action = asResponseOverrideAction(formData.action);
  return {
    ...baseFromForm(formData),
    action,
    status: asResponseOverrideStatus(formData.status, action),
  };
}

function inboundPolicyNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<InboundPolicyNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    action: asInboundPolicyAction(data.action),
    policy: asInboundPolicyMode(data.policy),
    errorCode: asInboundPolicyErrorCode(data.errorCode),
    errorDescription: optionalString(data.errorDescription),
  });
}

function inboundPolicyFormToNodeData(
  formData: NodeFormData,
): InboundPolicyNodeData {
  const policy = asInboundPolicyMode(formData.policy);
  return compactDefined({
    ...baseFromForm(formData),
    action: asInboundPolicyAction(formData.action),
    policy,
    ...(policy === "callerror"
      ? {
          errorCode: asInboundPolicyErrorCode(formData.errorCode),
          errorDescription: optionalString(formData.errorDescription),
        }
      : {}),
  }) as InboundPolicyNodeData;
}

function asCertQuirksMode(value: unknown): "set" | "clear" {
  return value === "clear" ? "clear" : "set";
}

function asCertQuirksPreset(value: unknown): "octt" | undefined {
  return value === "octt" ? "octt" : undefined;
}

function asCertKeyAlgorithm(value: unknown): "ECDSA" | "RSA" | undefined {
  return value === "ECDSA" || value === "RSA" ? value : undefined;
}

function asCertLineEndings(value: unknown): "lf" | "crlf" | undefined {
  return value === "lf" || value === "crlf" ? value : undefined;
}

/** Free-text entries reach this parser, and the CertificateSigned handler
 *  compares them verbatim against the leaf certificate's algorithm name —
 *  a typo would silently make the acceptance policy reject everything.
 *  Only the advertised algorithm names survive; an all-invalid list drops
 *  to undefined (no policy) rather than persisting as reject-everything. */
function parseCertAlgorithmArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.filter(
    (v): v is string =>
      typeof v === "string" && CERT_SIGNATURE_ALGORITHMS_SET.has(v),
  );
  return valid.length > 0 ? valid : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v) => typeof v === "string");
}

function certQuirksNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<CertQuirksNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    mode: asCertQuirksMode(data.mode),
    preset: asCertQuirksPreset(data.preset),
    csrKeyAlgorithm: asCertKeyAlgorithm(data.csrKeyAlgorithm),
    csrPemLineEndings: asCertLineEndings(data.csrPemLineEndings),
    requiredCertificateSignatureAlgorithms:
      data.requiredCertificateSignatureAlgorithms,
    hiddenConfigurationKeys: data.hiddenConfigurationKeys,
  });
}

function certQuirksFormToNodeData(formData: NodeFormData): CertQuirksNodeData {
  const mode = asCertQuirksMode(formData.mode);
  return compactDefined({
    ...baseFromForm(formData),
    mode,
    ...(mode === "set"
      ? {
          preset: asCertQuirksPreset(formData.preset),
          csrKeyAlgorithm: asCertKeyAlgorithm(formData.csrKeyAlgorithm),
          csrPemLineEndings: asCertLineEndings(formData.csrPemLineEndings),
          requiredCertificateSignatureAlgorithms: parseCertAlgorithmArray(
            formData.requiredCertificateSignatureAlgorithms,
          ),
          hiddenConfigurationKeys: parseStringArray(
            formData.hiddenConfigurationKeys,
          ),
        }
      : {}),
  }) as CertQuirksNodeData;
}

function asConnectionTriggerEvent(
  value: unknown,
): ConnectionTriggerNodeData["event"] {
  return value === "connected" ? "connected" : "disconnected";
}

function connectionTriggerNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    event: asConnectionTriggerEvent(
      (nodeData as Partial<ConnectionTriggerNodeData>).event,
    ),
    timeout: optionalNumber(
      (nodeData as Partial<ConnectionTriggerNodeData>).timeout,
    ),
  });
}

function connectionTriggerFormToNodeData(
  formData: NodeFormData,
): ConnectionTriggerNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    event: asConnectionTriggerEvent(formData.event),
    timeout: optionalNumber(formData.timeout),
  }) as ConnectionTriggerNodeData;
}

export const NODE_FORM_REGISTRY = {
  [ScenarioNodeType.STATUS_CHANGE]: {
    title: "scenarioEditor.node.statusChange",
    Component: StatusChangeForm,
    nodeDataToForm: statusChangeNodeDataToForm,
    formToNodeData: statusChangeFormToNodeData,
  },
  [ScenarioNodeType.TRANSACTION]: {
    title: "scenarioEditor.node.transaction",
    Component: TransactionForm,
    nodeDataToForm: transactionNodeDataToForm,
    formToNodeData: transactionFormToNodeData,
  },
  [ScenarioNodeType.METER_VALUE]: {
    title: "scenarioEditor.node.meterValue",
    Component: MeterValueForm,
    nodeDataToForm: meterValueNodeDataToForm,
    formToNodeData: meterValueFormToNodeData,
  },
  [ScenarioNodeType.DELAY]: {
    title: "scenarioEditor.node.delay",
    Component: DelayForm,
    nodeDataToForm: delayNodeDataToForm,
    formToNodeData: delayFormToNodeData,
  },
  [ScenarioNodeType.NOTIFICATION]: {
    title: "scenarioEditor.node.notification",
    Component: NotificationForm,
    nodeDataToForm: notificationNodeDataToForm,
    formToNodeData: notificationFormToNodeData,
  },
  [ScenarioNodeType.CONNECTOR_PLUG]: {
    title: "scenarioEditor.node.connectorPlug",
    Component: ConnectorPlugForm,
    nodeDataToForm: connectorPlugNodeDataToForm,
    formToNodeData: connectorPlugFormToNodeData,
  },
  [ScenarioNodeType.REMOTE_START_TRIGGER]: {
    title: "scenarioEditor.node.remoteStartTrigger",
    Component: RemoteStartTriggerForm,
    nodeDataToForm: remoteStartTriggerNodeDataToForm,
    formToNodeData: remoteStartTriggerFormToNodeData,
  },
  [ScenarioNodeType.REMOTE_STOP_TRIGGER]: {
    title: "scenarioEditor.node.remoteStopTrigger",
    Component: RemoteStopTriggerForm,
    nodeDataToForm: remoteStopTriggerNodeDataToForm,
    formToNodeData: remoteStopTriggerFormToNodeData,
  },
  [ScenarioNodeType.STATUS_TRIGGER]: {
    title: "scenarioEditor.node.statusTrigger",
    Component: StatusTriggerForm,
    nodeDataToForm: statusTriggerNodeDataToForm,
    formToNodeData: statusTriggerFormToNodeData,
  },
  [ScenarioNodeType.RESERVE_NOW]: {
    title: "scenarioEditor.node.reserveNow",
    Component: ReserveNowForm,
    nodeDataToForm: reserveNowNodeDataToForm,
    formToNodeData: reserveNowFormToNodeData,
  },
  [ScenarioNodeType.CANCEL_RESERVATION]: {
    title: "scenarioEditor.node.cancelReservation",
    Component: CancelReservationForm,
    nodeDataToForm: cancelReservationNodeDataToForm,
    formToNodeData: cancelReservationFormToNodeData,
  },
  [ScenarioNodeType.RESERVATION_TRIGGER]: {
    title: "scenarioEditor.node.reservationTrigger",
    Component: ReservationTriggerForm,
    nodeDataToForm: reservationTriggerNodeDataToForm,
    formToNodeData: reservationTriggerFormToNodeData,
  },
  [ScenarioNodeType.START]: {
    title: "scenarioEditor.node.start",
    Component: StartForm,
    nodeDataToForm: startNodeDataToForm,
    formToNodeData: startFormToNodeData,
  },
  [ScenarioNodeType.END]: {
    title: "scenarioEditor.node.end",
    Component: EndForm,
    nodeDataToForm: endNodeDataToForm,
    formToNodeData: endFormToNodeData,
  },
  [ScenarioNodeType.STATUS_NOTIFICATION]: {
    title: "scenarioEditor.node.statusNotification",
    Component: StatusNotificationForm,
    nodeDataToForm: statusNotificationNodeDataToForm,
    formToNodeData: statusNotificationFormToNodeData,
  },
  [ScenarioNodeType.UNLOCK_OUTCOME]: {
    title: "scenarioEditor.node.unlockOutcome",
    Component: UnlockOutcomeForm,
    nodeDataToForm: unlockOutcomeNodeDataToForm,
    formToNodeData: unlockOutcomeFormToNodeData,
  },
  [ScenarioNodeType.CSMS_CALL_TRIGGER]: {
    title: "scenarioEditor.node.csmsCallTrigger",
    Component: CsmsCallTriggerForm,
    nodeDataToForm: csmsCallTriggerNodeDataToForm,
    formToNodeData: csmsCallTriggerFormToNodeData,
  },
  [ScenarioNodeType.RESPONSE_OVERRIDE]: {
    title: "scenarioEditor.node.responseOverride",
    Component: ResponseOverrideForm,
    nodeDataToForm: responseOverrideNodeDataToForm,
    formToNodeData: responseOverrideFormToNodeData,
  },
  [ScenarioNodeType.INBOUND_POLICY]: {
    title: "scenarioEditor.node.inboundPolicy",
    Component: InboundPolicyForm,
    nodeDataToForm: inboundPolicyNodeDataToForm,
    formToNodeData: inboundPolicyFormToNodeData,
  },
  [ScenarioNodeType.CERT_QUIRKS]: {
    title: "scenarioEditor.node.certQuirks",
    Component: CertQuirksForm,
    nodeDataToForm: certQuirksNodeDataToForm,
    formToNodeData: certQuirksFormToNodeData,
  },
  [ScenarioNodeType.CONFIG_SET]: {
    title: "scenarioEditor.node.configSet",
    Component: ConfigSetForm,
    nodeDataToForm: configSetNodeDataToForm,
    formToNodeData: configSetFormToNodeData,
  },
  [ScenarioNodeType.DATA_TRANSFER]: {
    title: "scenarioEditor.node.dataTransfer",
    Component: DataTransferForm,
    nodeDataToForm: dataTransferNodeDataToForm,
    formToNodeData: dataTransferFormToNodeData,
  },
  [ScenarioNodeType.OCPP_CALL]: {
    title: "scenarioEditor.node.ocppCall",
    Component: OcppCallForm,
    nodeDataToForm: ocppCallNodeDataToForm,
    formToNodeData: ocppCallFormToNodeData,
  },
  [ScenarioNodeType.CALL_RESPONSE]: {
    title: "scenarioEditor.node.callResponse",
    Component: CallResponseForm,
    nodeDataToForm: callResponseNodeDataToForm,
    formToNodeData: callResponseFormToNodeData,
  },
  [ScenarioNodeType.USE_BEHAVIOR]: {
    title: "scenarioEditor.node.useBehavior",
    Component: UseBehaviorForm,
    nodeDataToForm: useBehaviorNodeDataToForm,
    formToNodeData: useBehaviorFormToNodeData,
  },
  [ScenarioNodeType.NOTIFY]: {
    title: "scenarioEditor.node.notify",
    Component: NotifyForm,
    nodeDataToForm: notifyNodeDataToForm,
    formToNodeData: notifyFormToNodeData,
  },
  [ScenarioNodeType.SWITCH]: {
    title: "scenarioEditor.node.switch",
    Component: SwitchForm,
    nodeDataToForm: switchNodeDataToForm,
    formToNodeData: switchFormToNodeData,
  },
  [ScenarioNodeType.CHOICE]: {
    title: "scenarioEditor.node.choice",
    Component: ChoiceForm,
    nodeDataToForm: choiceNodeDataToForm,
    formToNodeData: choiceFormToNodeData,
  },
  [ScenarioNodeType.SET_STATE]: {
    title: "scenarioEditor.node.setState",
    Component: SetStateForm,
    nodeDataToForm: setStateNodeDataToForm,
    formToNodeData: setStateFormToNodeData,
  },
  [ScenarioNodeType.CONNECTION_TRIGGER]: {
    title: "scenarioEditor.node.connectionTrigger",
    Component: ConnectionTriggerForm,
    nodeDataToForm: connectionTriggerNodeDataToForm,
    formToNodeData: connectionTriggerFormToNodeData,
  },
  [ScenarioFlowNodeType.PARALLEL]: {
    title: "scenarioEditor.node.parallel",
    Component: EndForm,
    nodeDataToForm: endNodeDataToForm,
    formToNodeData: endFormToNodeData,
  },
  [ScenarioFlowNodeType.JOIN]: {
    title: "scenarioEditor.node.join",
    Component: JoinForm,
    nodeDataToForm: joinNodeDataToForm,
    formToNodeData: joinFormToNodeData,
  },
} satisfies Record<AnyScenarioNodeType, NodeFormEntry>;

export function isScenarioNodeType(
  value: unknown,
): value is AnyScenarioNodeType {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(NODE_FORM_REGISTRY, value)
  );
}
