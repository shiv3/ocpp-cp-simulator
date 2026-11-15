import {
  type AnyScenarioNodeType,
  ScenarioFlowNodeType,
  type ScenarioNodeData,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { MessageKey } from "../../../i18n";
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

import {
  statusChangeNodeDataToForm,
  statusChangeFormToNodeData,
  transactionNodeDataToForm,
  transactionFormToNodeData,
  delayNodeDataToForm,
  delayFormToNodeData,
  notificationNodeDataToForm,
  notificationFormToNodeData,
  connectorPlugNodeDataToForm,
  connectorPlugFormToNodeData,
  remoteStartTriggerNodeDataToForm,
  remoteStartTriggerFormToNodeData,
  remoteStopTriggerNodeDataToForm,
  remoteStopTriggerFormToNodeData,
  statusTriggerNodeDataToForm,
  statusTriggerFormToNodeData,
  reserveNowNodeDataToForm,
  reserveNowFormToNodeData,
  cancelReservationNodeDataToForm,
  cancelReservationFormToNodeData,
  reservationTriggerNodeDataToForm,
  reservationTriggerFormToNodeData,
  startNodeDataToForm,
  startFormToNodeData,
  endNodeDataToForm,
  endFormToNodeData,
  joinNodeDataToForm,
  joinFormToNodeData,
  statusNotificationNodeDataToForm,
  statusNotificationFormToNodeData,
  unlockOutcomeNodeDataToForm,
  unlockOutcomeFormToNodeData,
  configSetNodeDataToForm,
  configSetFormToNodeData,
  dataTransferNodeDataToForm,
  dataTransferFormToNodeData,
  meterValueFormToNodeData,
  meterValueNodeDataToForm,
} from "./nodeForm/core";
import {
  ocppCallNodeDataToForm,
  ocppCallFormToNodeData,
  callResponseNodeDataToForm,
  callResponseFormToNodeData,
  notifyNodeDataToForm,
  notifyFormToNodeData,
  switchNodeDataToForm,
  switchFormToNodeData,
  choiceNodeDataToForm,
  choiceFormToNodeData,
  setStateNodeDataToForm,
  setStateFormToNodeData,
  useBehaviorNodeDataToForm,
  useBehaviorFormToNodeData,
  csmsCallTriggerNodeDataToForm,
  csmsCallTriggerFormToNodeData,
  responseOverrideNodeDataToForm,
  responseOverrideFormToNodeData,
  inboundPolicyNodeDataToForm,
  inboundPolicyFormToNodeData,
} from "./nodeForm/messaging";
import {
  certQuirksNodeDataToForm,
  certQuirksFormToNodeData,
  connectionTriggerNodeDataToForm,
  connectionTriggerFormToNodeData,
} from "./nodeForm/cert";

export interface NodeFormEntry<TFormData extends NodeFormData = NodeFormData> {
  /** Message key of the node type's display name. */
  title: MessageKey;
  Component: NodeFormComponent<TFormData>;
  nodeDataToForm: (nodeData: ScenarioNodeData) => TFormData;
  formToNodeData: (formData: TFormData) => ScenarioNodeData;
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

export { meterValueFormToNodeData, meterValueNodeDataToForm };
