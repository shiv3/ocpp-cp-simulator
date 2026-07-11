import {
  type BaseNodeData,
  type CancelReservationNodeData,
  type ConfigSetNodeData,
  type ConnectorPlugNodeData,
  type CsmsCallTriggerNodeData,
  type DataTransferNodeData,
  type DelayNodeData,
  type MeterValueNodeData,
  type NotificationNodeData,
  type RemoteStartTriggerNodeData,
  type RemoteStopTriggerNodeData,
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
import ConfigSetForm from "./ConfigSetForm";
import ConnectorPlugForm from "./ConnectorPlugForm";
import CsmsCallTriggerForm from "./CsmsCallTriggerForm";
import DataTransferForm from "./DataTransferForm";
import DelayForm from "./DelayForm";
import EndForm from "./EndForm";
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
    action: (nodeData as Partial<CsmsCallTriggerNodeData>).action ?? "Reset",
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
    action: typeof formData.action === "string" ? formData.action : "Reset",
    timeout: optionalNumber(formData.timeout),
  }) as CsmsCallTriggerNodeData;
}

function responseOverrideNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    action:
      (nodeData as Partial<ResponseOverrideNodeData>).action ??
      "RemoteStartTransaction",
    status:
      (nodeData as Partial<ResponseOverrideNodeData>).status ?? "Rejected",
  });
}

function responseOverrideFormToNodeData(
  formData: NodeFormData,
): ResponseOverrideNodeData {
  return {
    ...baseFromForm(formData),
    action:
      typeof formData.action === "string"
        ? formData.action
        : "RemoteStartTransaction",
    status: typeof formData.status === "string" ? formData.status : "Rejected",
  };
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
