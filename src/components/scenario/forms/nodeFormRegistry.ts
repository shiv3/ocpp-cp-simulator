import {
  type BaseNodeData,
  type CancelReservationNodeData,
  CERT_SIGNATURE_ALGORITHMS,
  type CertQuirksNodeData,
  type ConfigSetNodeData,
  type ConnectorPlugNodeData,
  CSMS_CALL_TRIGGER_ACTIONS,
  type CsmsCallTriggerNodeData,
  type DataTransferNodeData,
  type DelayNodeData,
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
} from "../../../cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { CurvePoint } from "../../../cp/domain/connector/MeterValueCurve";
import CancelReservationForm from "./CancelReservationForm";
import CertQuirksForm from "./CertQuirksForm";
import ConfigSetForm from "./ConfigSetForm";
import ConnectorPlugForm from "./ConnectorPlugForm";
import CsmsCallTriggerForm from "./CsmsCallTriggerForm";
import DataTransferForm from "./DataTransferForm";
import DelayForm from "./DelayForm";
import EndForm from "./EndForm";
import InboundPolicyForm from "./InboundPolicyForm";
import MeterValueForm from "./MeterValueForm";
import NotificationForm from "./NotificationForm";
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
  title: string;
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

function delayNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    delaySeconds: numberValue(
      (nodeData as Partial<DelayNodeData>).delaySeconds,
    ),
  });
}

function delayFormToNodeData(formData: NodeFormData): DelayNodeData {
  return {
    ...baseFromForm(formData),
    delaySeconds: numberValue(formData.delaySeconds),
  };
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
  });
}

function csmsCallTriggerFormToNodeData(
  formData: NodeFormData,
): CsmsCallTriggerNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    action: asCsmsCallTriggerAction(formData.action),
    timeout: optionalNumber(formData.timeout),
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

export const NODE_FORM_REGISTRY = {
  [ScenarioNodeType.STATUS_CHANGE]: {
    title: "Status Change",
    Component: StatusChangeForm,
    nodeDataToForm: statusChangeNodeDataToForm,
    formToNodeData: statusChangeFormToNodeData,
  },
  [ScenarioNodeType.TRANSACTION]: {
    title: "Transaction",
    Component: TransactionForm,
    nodeDataToForm: transactionNodeDataToForm,
    formToNodeData: transactionFormToNodeData,
  },
  [ScenarioNodeType.METER_VALUE]: {
    title: "Meter Value",
    Component: MeterValueForm,
    nodeDataToForm: meterValueNodeDataToForm,
    formToNodeData: meterValueFormToNodeData,
  },
  [ScenarioNodeType.DELAY]: {
    title: "Delay",
    Component: DelayForm,
    nodeDataToForm: delayNodeDataToForm,
    formToNodeData: delayFormToNodeData,
  },
  [ScenarioNodeType.NOTIFICATION]: {
    title: "Notification",
    Component: NotificationForm,
    nodeDataToForm: notificationNodeDataToForm,
    formToNodeData: notificationFormToNodeData,
  },
  [ScenarioNodeType.CONNECTOR_PLUG]: {
    title: "Connector Plug",
    Component: ConnectorPlugForm,
    nodeDataToForm: connectorPlugNodeDataToForm,
    formToNodeData: connectorPlugFormToNodeData,
  },
  [ScenarioNodeType.REMOTE_START_TRIGGER]: {
    title: "Remote Start Trigger",
    Component: RemoteStartTriggerForm,
    nodeDataToForm: remoteStartTriggerNodeDataToForm,
    formToNodeData: remoteStartTriggerFormToNodeData,
  },
  [ScenarioNodeType.REMOTE_STOP_TRIGGER]: {
    title: "Remote Stop Trigger",
    Component: RemoteStopTriggerForm,
    nodeDataToForm: remoteStopTriggerNodeDataToForm,
    formToNodeData: remoteStopTriggerFormToNodeData,
  },
  [ScenarioNodeType.STATUS_TRIGGER]: {
    title: "Status Trigger",
    Component: StatusTriggerForm,
    nodeDataToForm: statusTriggerNodeDataToForm,
    formToNodeData: statusTriggerFormToNodeData,
  },
  [ScenarioNodeType.RESERVE_NOW]: {
    title: "Reserve Now",
    Component: ReserveNowForm,
    nodeDataToForm: reserveNowNodeDataToForm,
    formToNodeData: reserveNowFormToNodeData,
  },
  [ScenarioNodeType.CANCEL_RESERVATION]: {
    title: "Cancel Reservation",
    Component: CancelReservationForm,
    nodeDataToForm: cancelReservationNodeDataToForm,
    formToNodeData: cancelReservationFormToNodeData,
  },
  [ScenarioNodeType.RESERVATION_TRIGGER]: {
    title: "Reservation Trigger",
    Component: ReservationTriggerForm,
    nodeDataToForm: reservationTriggerNodeDataToForm,
    formToNodeData: reservationTriggerFormToNodeData,
  },
  [ScenarioNodeType.START]: {
    title: "Start",
    Component: StartForm,
    nodeDataToForm: startNodeDataToForm,
    formToNodeData: startFormToNodeData,
  },
  [ScenarioNodeType.END]: {
    title: "End",
    Component: EndForm,
    nodeDataToForm: endNodeDataToForm,
    formToNodeData: endFormToNodeData,
  },
  [ScenarioNodeType.STATUS_NOTIFICATION]: {
    title: "Status Notification",
    Component: StatusNotificationForm,
    nodeDataToForm: statusNotificationNodeDataToForm,
    formToNodeData: statusNotificationFormToNodeData,
  },
  [ScenarioNodeType.UNLOCK_OUTCOME]: {
    title: "Unlock Outcome",
    Component: UnlockOutcomeForm,
    nodeDataToForm: unlockOutcomeNodeDataToForm,
    formToNodeData: unlockOutcomeFormToNodeData,
  },
  [ScenarioNodeType.CSMS_CALL_TRIGGER]: {
    title: "CSMS Call Trigger",
    Component: CsmsCallTriggerForm,
    nodeDataToForm: csmsCallTriggerNodeDataToForm,
    formToNodeData: csmsCallTriggerFormToNodeData,
  },
  [ScenarioNodeType.RESPONSE_OVERRIDE]: {
    title: "Response Override",
    Component: ResponseOverrideForm,
    nodeDataToForm: responseOverrideNodeDataToForm,
    formToNodeData: responseOverrideFormToNodeData,
  },
  [ScenarioNodeType.INBOUND_POLICY]: {
    title: "Inbound Policy",
    Component: InboundPolicyForm,
    nodeDataToForm: inboundPolicyNodeDataToForm,
    formToNodeData: inboundPolicyFormToNodeData,
  },
  [ScenarioNodeType.CERT_QUIRKS]: {
    title: "Certificate Quirks",
    Component: CertQuirksForm,
    nodeDataToForm: certQuirksNodeDataToForm,
    formToNodeData: certQuirksFormToNodeData,
  },
  [ScenarioNodeType.CONFIG_SET]: {
    title: "Config Set",
    Component: ConfigSetForm,
    nodeDataToForm: configSetNodeDataToForm,
    formToNodeData: configSetFormToNodeData,
  },
  [ScenarioNodeType.DATA_TRANSFER]: {
    title: "Data Transfer",
    Component: DataTransferForm,
    nodeDataToForm: dataTransferNodeDataToForm,
    formToNodeData: dataTransferFormToNodeData,
  },
} satisfies Record<ScenarioNodeType, NodeFormEntry>;

export function isScenarioNodeType(value: unknown): value is ScenarioNodeType {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(NODE_FORM_REGISTRY, value)
  );
}
