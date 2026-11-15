import type {
  ScenarioNode,
  CallResponseNodeData,
  CancelReservationNodeData,
  CertQuirksNodeData,
  ChoiceNodeData,
  ConfigSetNodeData,
  ConnectionTriggerNodeData,
  ConnectorPlugNodeData,
  CsmsCallTriggerNodeData,
  DataTransferNodeData,
  DelayNodeData,
  InboundPolicyNodeData,
  MeterValueNodeData,
  NotificationNodeData,
  NotifyNodeData,
  OcppCallNodeData,
  RemoteStartTriggerNodeData,
  RemoteStopTriggerNodeData,
  ReservationTriggerNodeData,
  ReserveNowNodeData,
  ResponseOverrideNodeData,
  SetStateNodeData,
  StatusChangeNodeData,
  StatusNotificationNodeData,
  StatusTriggerNodeData,
  SwitchNodeData,
  TransactionNodeData,
  UnlockOutcomeNodeData,
  UseBehaviorNodeData,
} from "../ScenarioTypes";
import { ScenarioFlowNodeType, ScenarioNodeType } from "../ScenarioTypes";
import type { Flow, NodeRunContext } from "./context";
import {
  executeCertQuirks,
  executeInboundPolicy,
  executeResponseOverride,
} from "./policies";
import { executeMeterValue } from "./meterValue";
import {
  executeChoice,
  executeNotify,
  executeSetState,
  executeSwitch,
} from "./branching";
import {
  executeCallResponse,
  executeConfigSet,
  executeDataTransfer,
  executeOcppCall,
  executeStatusNotification,
  executeUnlockOutcome,
  executeUseBehavior,
} from "./calls";
import {
  executeConnectorPlug,
  executeDelay,
  executeNotification,
  executeStatusChange,
  executeTransaction,
} from "./transaction";
import {
  executeCancelReservation,
  executeConnectionTrigger,
  executeCsmsCallTrigger,
  executeRemoteStartTrigger,
  executeRemoteStopTrigger,
  executeReservationTrigger,
  executeReserveNow,
  executeStatusTrigger,
} from "./triggers";

/**
 * Execute a single node
 */
export async function executeNode(
  ctx: NodeRunContext,
  node: ScenarioNode,
  flow: Flow,
): Promise<void> {
  // Log node execution
  const nodeLabel = node.data?.label || node.id;
  ctx.callbacks.log?.(
    `[${ctx.scenario.name}] Executing node: ${nodeLabel} (${node.type})`,
    "debug",
  );

  switch (node.type) {
    case ScenarioNodeType.STATUS_CHANGE:
      await executeStatusChange(ctx, node.data as StatusChangeNodeData);
      break;

    case ScenarioNodeType.TRANSACTION:
      await executeTransaction(ctx, node.data as TransactionNodeData);
      break;

    case ScenarioNodeType.METER_VALUE:
      await executeMeterValue(
        ctx,
        node.id,
        node.data as MeterValueNodeData,
        flow.scope,
      );
      break;

    case ScenarioNodeType.DELAY:
      await executeDelay(ctx, node.id, node.data as DelayNodeData, flow.scope);
      break;

    case ScenarioNodeType.NOTIFICATION:
      await executeNotification(ctx, node.data as NotificationNodeData);
      break;

    case ScenarioNodeType.CONNECTOR_PLUG:
      await executeConnectorPlug(ctx, node.data as ConnectorPlugNodeData);
      break;

    case ScenarioNodeType.REMOTE_START_TRIGGER:
      await executeRemoteStartTrigger(
        ctx,
        node.id,
        node.data as RemoteStartTriggerNodeData,
        flow,
      );
      break;

    case ScenarioNodeType.REMOTE_STOP_TRIGGER:
      await executeRemoteStopTrigger(
        ctx,
        node.id,
        node.data as RemoteStopTriggerNodeData,
        flow,
      );
      break;

    case ScenarioNodeType.STATUS_TRIGGER:
      await executeStatusTrigger(
        ctx,
        node.id,
        node.data as StatusTriggerNodeData,
        flow,
      );
      break;

    case ScenarioNodeType.RESERVE_NOW:
      await executeReserveNow(ctx, node.data as ReserveNowNodeData);
      break;

    case ScenarioNodeType.CANCEL_RESERVATION:
      await executeCancelReservation(
        ctx,
        node.data as CancelReservationNodeData,
      );
      break;

    case ScenarioNodeType.RESERVATION_TRIGGER:
      await executeReservationTrigger(
        ctx,
        node.id,
        node.data as ReservationTriggerNodeData,
        flow,
      );
      break;

    case ScenarioNodeType.CSMS_CALL_TRIGGER:
      await executeCsmsCallTrigger(
        ctx,
        node.id,
        node.data as CsmsCallTriggerNodeData,
        flow,
      );
      break;

    case ScenarioNodeType.STATUS_NOTIFICATION:
      await executeStatusNotification(
        ctx,
        node.data as StatusNotificationNodeData,
      );
      break;

    case ScenarioNodeType.UNLOCK_OUTCOME:
      await executeUnlockOutcome(ctx, node.data as UnlockOutcomeNodeData);
      break;

    case ScenarioNodeType.RESPONSE_OVERRIDE:
      await executeResponseOverride(ctx, node.data as ResponseOverrideNodeData);
      break;

    case ScenarioNodeType.INBOUND_POLICY:
      await executeInboundPolicy(ctx, node.data as InboundPolicyNodeData);
      break;

    case ScenarioNodeType.CERT_QUIRKS:
      await executeCertQuirks(ctx, node.data as CertQuirksNodeData);
      break;

    case ScenarioNodeType.CONFIG_SET:
      await executeConfigSet(ctx, node.data as ConfigSetNodeData);
      break;

    case ScenarioNodeType.DATA_TRANSFER:
      await executeDataTransfer(ctx, node.data as DataTransferNodeData);
      break;

    case ScenarioNodeType.OCPP_CALL:
      await executeOcppCall(ctx, node.data as OcppCallNodeData, flow);
      break;

    case ScenarioNodeType.CALL_RESPONSE:
      await executeCallResponse(ctx, node.data as CallResponseNodeData, flow);
      break;

    case ScenarioNodeType.USE_BEHAVIOR:
      executeUseBehavior(ctx, node.id, node.data as UseBehaviorNodeData);
      break;

    case ScenarioNodeType.NOTIFY:
      executeNotify(ctx, node.data as NotifyNodeData, flow);
      break;

    case ScenarioNodeType.SWITCH:
      executeSwitch(ctx, node.data as SwitchNodeData, flow);
      break;

    case ScenarioNodeType.CHOICE:
      executeChoice(ctx, node.data as ChoiceNodeData, flow);
      break;

    case ScenarioNodeType.SET_STATE:
      executeSetState(ctx, node.data as SetStateNodeData, flow);
      break;

    case ScenarioNodeType.CONNECTION_TRIGGER:
      await executeConnectionTrigger(
        ctx,
        node.id,
        node.data as ConnectionTriggerNodeData,
        flow,
      );
      break;

    // Schema 1.9: control flow only; the walk forks and meets.
    case ScenarioFlowNodeType.PARALLEL:
    case ScenarioFlowNodeType.JOIN:
      break;

    default:
      console.warn(`Unknown node type: ${node.type}`);
  }
}
