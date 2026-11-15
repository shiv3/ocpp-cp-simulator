import {
  type BaseNodeData,
  type CancelReservationNodeData,
  type ConfigSetNodeData,
  type ConnectorPlugNodeData,
  type DataTransferNodeData,
  type DelayNodeData,
  type JoinNodeData,
  type MeterValueNodeData,
  type NotificationNodeData,
  type RemoteStartTriggerNodeData,
  type RemoteStopTriggerNodeData,
  type ReservationTriggerNodeData,
  type ReserveNowNodeData,
  type ScenarioNodeData,
  type StartNodeData,
  type StatusChangeNodeData,
  type StatusNotificationNodeData,
  type StatusTriggerNodeData,
  type TransactionNodeData,
  type UnlockOutcomeNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type { NodeFormData } from "../types";
import {
  compactDefined,
  stringValue,
  optionalString,
  numberValue,
  optionalNumber,
  optionalBoolean,
  booleanValue,
  asOcppStatus,
  baseToForm,
  baseFromForm,
  transactionAction,
  connectorAction,
  stopMode,
  triggerOn,
  unlockOutcome,
  curvePoints,
  payloadValue,
} from "./coerce";

export function statusChangeNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    status: asOcppStatus(
      (nodeData as Partial<StatusChangeNodeData>).status,
      OCPPStatus.Available,
    ),
    // Schema 1.11 (#618): no control of its own; kept so an edit of the
    // status does not drop it.
    allowInvalidTransition: optionalBoolean(
      (nodeData as Partial<StatusChangeNodeData>).allowInvalidTransition,
    ),
  });
}

export function statusChangeFormToNodeData(
  formData: NodeFormData,
): StatusChangeNodeData {
  const allowInvalidTransition = optionalBoolean(
    formData.allowInvalidTransition,
  );
  return {
    ...baseFromForm(formData),
    status: asOcppStatus(formData.status, OCPPStatus.Available),
    ...(allowInvalidTransition !== undefined ? { allowInvalidTransition } : {}),
  };
}

export function transactionNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  const data = nodeData as Partial<TransactionNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    action: transactionAction(data.action),
    tagId: optionalString(data.tagId),
    batteryCapacityKwh: optionalNumber(data.batteryCapacityKwh),
    initialSoc: optionalNumber(data.initialSoc),
  });
}

export function transactionFormToNodeData(
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

export function delayNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    delaySeconds: numberValue(
      (nodeData as Partial<DelayNodeData>).delaySeconds,
    ),
    ...delayExtras(nodeData as Partial<DelayNodeData>),
  });
}

export function delayFormToNodeData(formData: NodeFormData): DelayNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    delaySeconds: numberValue(formData.delaySeconds),
    ...delayExtras(formData as Partial<DelayNodeData>),
  }) as DelayNodeData;
}

export function notificationNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  const data = nodeData as Partial<NotificationNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    messageType: stringValue(data.messageType),
    payload: payloadValue(data.payload),
  });
}

export function notificationFormToNodeData(
  formData: NodeFormData,
): NotificationNodeData {
  return {
    ...baseFromForm(formData),
    messageType: stringValue(formData.messageType),
    payload: payloadValue(formData.payload) as Record<string, unknown>,
  };
}

export function connectorPlugNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    action: connectorAction(
      (nodeData as Partial<ConnectorPlugNodeData>).action,
    ),
  });
}

export function connectorPlugFormToNodeData(
  formData: NodeFormData,
): ConnectorPlugNodeData {
  return {
    ...baseFromForm(formData),
    action: connectorAction(formData.action),
  };
}

export function remoteStartTriggerNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    timeout: optionalNumber(
      (nodeData as Partial<RemoteStartTriggerNodeData>).timeout,
    ),
  });
}

export function remoteStartTriggerFormToNodeData(
  formData: NodeFormData,
): RemoteStartTriggerNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    timeout: optionalNumber(formData.timeout),
  });
}

export function remoteStopTriggerNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    timeout: optionalNumber(
      (nodeData as Partial<RemoteStopTriggerNodeData>).timeout,
    ),
  });
}

export function remoteStopTriggerFormToNodeData(
  formData: NodeFormData,
): RemoteStopTriggerNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    timeout: optionalNumber(formData.timeout),
  });
}

export function statusTriggerNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  const data = nodeData as Partial<StatusTriggerNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    targetStatus: asOcppStatus(data.targetStatus, OCPPStatus.Charging),
    timeout: optionalNumber(data.timeout),
  });
}

export function statusTriggerFormToNodeData(
  formData: NodeFormData,
): StatusTriggerNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    targetStatus: asOcppStatus(formData.targetStatus, OCPPStatus.Charging),
    timeout: optionalNumber(formData.timeout),
  }) as StatusTriggerNodeData;
}

export function reserveNowNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  const data = nodeData as Partial<ReserveNowNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    expiryMinutes: numberValue(data.expiryMinutes),
    idTag: stringValue(data.idTag),
    parentIdTag: optionalString(data.parentIdTag),
    reservationId: optionalNumber(data.reservationId),
  });
}

export function reserveNowFormToNodeData(
  formData: NodeFormData,
): ReserveNowNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    expiryMinutes: numberValue(formData.expiryMinutes),
    idTag: stringValue(formData.idTag),
    parentIdTag: optionalString(formData.parentIdTag),
    reservationId: optionalNumber(formData.reservationId),
  }) as ReserveNowNodeData;
}

export function cancelReservationNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    reservationId: numberValue(
      (nodeData as Partial<CancelReservationNodeData>).reservationId,
    ),
  });
}

export function cancelReservationFormToNodeData(
  formData: NodeFormData,
): CancelReservationNodeData {
  return {
    ...baseFromForm(formData),
    reservationId: numberValue(formData.reservationId),
  };
}

export function reservationTriggerNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    timeout: optionalNumber(
      (nodeData as Partial<ReservationTriggerNodeData>).timeout,
    ),
  });
}

export function reservationTriggerFormToNodeData(
  formData: NodeFormData,
): ReservationTriggerNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    timeout: optionalNumber(formData.timeout),
  });
}

export function startNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<StartNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    triggerOn: triggerOn(data.triggerOn),
    targetStatus: asOcppStatus(data.targetStatus, OCPPStatus.Available),
  });
}

export function startFormToNodeData(formData: NodeFormData): StartNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    triggerOn: triggerOn(formData.triggerOn),
    targetStatus:
      formData.targetStatus === undefined
        ? undefined
        : asOcppStatus(formData.targetStatus, OCPPStatus.Available),
  }) as StartNodeData;
}

export function endNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  return baseToForm(nodeData);
}

export function endFormToNodeData(formData: NodeFormData): BaseNodeData {
  return baseFromForm(formData);
}

export function joinNodeDataToForm(nodeData: ScenarioNodeData): NodeFormData {
  const data = nodeData as Partial<JoinNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    mode: data.mode === "any" ? "any" : "all",
  });
}

export function joinFormToNodeData(formData: NodeFormData): JoinNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    mode: formData.mode === "any" ? ("any" as const) : undefined,
  }) as JoinNodeData;
}

export function statusNotificationNodeDataToForm(
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

export function statusNotificationFormToNodeData(
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

export function unlockOutcomeNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    outcome: unlockOutcome(
      (nodeData as Partial<UnlockOutcomeNodeData>).outcome,
    ),
  });
}

export function unlockOutcomeFormToNodeData(
  formData: NodeFormData,
): UnlockOutcomeNodeData {
  return {
    ...baseFromForm(formData),
    outcome: unlockOutcome(formData.outcome),
  };
}

export function configSetNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  const data = nodeData as Partial<ConfigSetNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    key: stringValue(data.key),
    value: stringValue(data.value),
  });
}

export function configSetFormToNodeData(
  formData: NodeFormData,
): ConfigSetNodeData {
  return {
    ...baseFromForm(formData),
    key: stringValue(formData.key),
    value: stringValue(formData.value),
  };
}

export function dataTransferNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  const data = nodeData as Partial<DataTransferNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    vendorId: stringValue(data.vendorId),
    messageId: optionalString(data.messageId),
    data: optionalString(data.data),
  });
}

export function dataTransferFormToNodeData(
  formData: NodeFormData,
): DataTransferNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    vendorId: stringValue(formData.vendorId),
    messageId: optionalString(formData.messageId),
    data: optionalString(formData.data),
  }) as DataTransferNodeData;
}
