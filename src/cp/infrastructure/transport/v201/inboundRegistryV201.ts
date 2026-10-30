import type {
  FirmwareStatusNotificationRequestV201,
  LogStatusNotificationRequestV201,
} from "../../../../ocpp";
import type {
  AuthorizeRequestV201,
  BootNotificationRequestV201,
  DataTransferRequestV201,
  GetBaseReportRequestV201,
  GetBaseReportResponseV201,
  GetReportRequestV201,
  GetReportResponseV201,
  GetVariablesRequestV201,
  HeartbeatRequestV201,
  MeterValuesRequestV201,
  NotifyReportRequestV201,
  ReportChargingProfilesRequestV201,
  ClearVariableMonitoringRequestV201,
  SetMonitoringBaseRequestV201,
  SetMonitoringBaseResponseV201,
  SetMonitoringLevelRequestV201,
  SetVariableMonitoringRequestV201,
  SecurityEventNotificationRequestV201,
  SetVariablesRequestV201,
  SignCertificateRequestV201,
  StatusNotificationRequestV201,
  TransactionEventRequestV201,
} from "../../../../ocpp";
import {
  isValidCancelReservationRequestV201,
  isValidCertificateSignedRequestV201,
  isValidChangeAvailabilityRequestV201,
  isValidClearCacheRequestV201,
  isValidClearChargingProfileRequestV201,
  isValidClearDisplayMessageRequestV201,
  isValidClearVariableMonitoringRequestV201,
  isValidCostUpdatedRequestV201,
  isValidCustomerInformationRequestV201,
  isValidDataTransferRequestV201,
  isValidDeleteCertificateRequestV201,
  isValidGetBaseReportRequestV201,
  isValidGetChargingProfilesRequestV201,
  isValidGetCompositeScheduleRequestV201,
  isValidGetDisplayMessagesRequestV201,
  isValidGetInstalledCertificateIdsRequestV201,
  isValidGetLocalListVersionRequestV201,
  isValidGetLogRequestV201,
  isValidGetMonitoringReportRequestV201,
  isValidGetReportRequestV201,
  isValidGetTransactionStatusRequestV201,
  isValidGetVariablesRequestV201,
  isValidInstallCertificateRequestV201,
  isValidPublishFirmwareRequestV201,
  isValidReserveNowRequestV201,
  isValidRequestStartTransactionRequestV201,
  isValidRequestStopTransactionRequestV201,
  isValidResetRequestV201,
  isValidSendLocalListRequestV201,
  isValidSetChargingProfileRequestV201,
  isValidSetDisplayMessageRequestV201,
  isValidSetMonitoringBaseRequestV201,
  isValidSetMonitoringLevelRequestV201,
  isValidSetNetworkProfileRequestV201,
  isValidSetVariableMonitoringRequestV201,
  isValidSetVariablesRequestV201,
  isValidTriggerMessageRequestV201,
  isValidUnlockConnectorRequestV201,
  isValidUnpublishFirmwareRequestV201,
  isValidUpdateFirmwareRequestV201,
} from "../../../../ocpp/validation/v201";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Logger } from "../../../shared/Logger";
import { buildBaseReportData } from "./baseReportV201";
import {
  buildCertificateHandlersV2x,
  V201_CERTIFICATE_MAPPING,
} from "./certificatesV201";
import {
  handleClearDisplayMessageAckV201,
  handleCostUpdatedAckV201,
  handleCustomerInformationAckV201,
  handleDataTransferAckV201,
  handleGetDisplayMessagesAckV201,
  handleGetLocalListVersionAckV201,
  handleGetLogAckV201,
  handlePublishFirmwareAckV201,
  handleSendLocalListAckV201,
  handleSetDisplayMessageAckV201,
  handleSetNetworkProfileAckV201,
  handleUnpublishFirmwareAckV201,
  handleUpdateFirmwareAckV201,
} from "./csmsAcksV201";
import {
  handleCancelReservationV201,
  handleChangeAvailabilityV201,
  handleClearCacheV201,
  handleReserveNowV201,
  handleResetV201,
  handleTriggerMessageV201,
  handleUnlockConnectorV201,
} from "./coreControlV201";
import { handleGetVariablesV201 } from "./getVariablesV201";
import { handleSetVariablesV201 } from "./setVariablesV201";
import { v201EvseExists } from "./topologyWireV201";
import {
  createGetMonitoringReportHandlerV201,
  handleClearVariableMonitoringV201,
  handleSetMonitoringLevelV201,
  handleSetVariableMonitoringV201,
  type NotifyMonitoringReportPayload,
} from "./variableMonitoringV201";
import type { NotifyEventPayload } from "./notifyEventV201";
import {
  handleGetTransactionStatusV201,
  handleRequestStartTransactionV201,
  handleRequestStopTransactionV201,
} from "./transactionControlV201";
import {
  handleClearChargingProfileV201,
  handleGetChargingProfilesV201,
  handleGetCompositeScheduleV201,
  handleSetChargingProfileV201,
} from "./smartChargingV201";

export type V201Action =
  | "BootNotification"
  | "Heartbeat"
  | "StatusNotification"
  | "TransactionEvent"
  | "MeterValues"
  | "Authorize"
  | "DataTransfer"
  | "NotifyReport"
  // #457: N02 report answering GetMonitoringReport.
  | "NotifyMonitoringReport"
  // #457: N07 variable-monitor events.
  | "NotifyEvent"
  | "ReportChargingProfiles"
  // #345: station-initiated firmware / log lifecycle reports (L01/L02, N01).
  | "FirmwareStatusNotification"
  | "LogStatusNotification"
  // #456: A02 certificate signing and its security event (A02.FR.07).
  | "SignCertificate"
  | "SecurityEventNotification";

export type V201RequestPayload =
  | BootNotificationRequestV201
  | HeartbeatRequestV201
  | StatusNotificationRequestV201
  | TransactionEventRequestV201
  | MeterValuesRequestV201
  | AuthorizeRequestV201
  | DataTransferRequestV201
  | NotifyReportRequestV201
  | NotifyMonitoringReportPayload
  | NotifyEventPayload
  | ReportChargingProfilesRequestV201
  | FirmwareStatusNotificationRequestV201
  | LogStatusNotificationRequestV201
  | SignCertificateRequestV201
  | SecurityEventNotificationRequestV201;

export interface V201InboundContext {
  readonly chargePoint: ChargePoint;
  readonly logger: Logger;
  readonly sendCall: (action: V201Action, payload: V201RequestPayload) => void;
}

export interface V201HandlerResult {
  readonly response: unknown;
  readonly afterResult?: () => void;
}

export interface V201InboundHandler {
  readonly validate: (data: unknown) => boolean;
  /**
   * A handler may answer asynchronously (#456: certificate hashing). The
   * dispatcher awaits only a real promise, so a synchronous handler still
   * answers in the same tick as its CALL.
   */
  readonly handle: (
    payload: unknown,
    ctx: V201InboundContext,
  ) => V201HandlerResult | Promise<V201HandlerResult>;
}

export type V201InboundRegistry = ReadonlyMap<string, V201InboundHandler>;

/** Whether the charge point has this EVSE (and connector). */
function evseOf(
  ctx: V201InboundContext,
  evse: { id: number; connectorId?: number },
): boolean {
  return v201EvseExists(evse, ctx.chargePoint.connectors.keys());
}

export function handleGetBaseReportV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  const req = payload as GetBaseReportRequestV201;
  const reportData = buildBaseReportData(
    ctx.chargePoint.configuration,
    ctx.chargePoint.connectors.keys(),
    ctx.chargePoint.deviceModelTargets,
  );
  const first = reportData[0];
  if (first === undefined) {
    return {
      response: {
        status: "EmptyResultSet",
      } satisfies GetBaseReportResponseV201,
    };
  }

  return {
    response: { status: "Accepted" } satisfies GetBaseReportResponseV201,
    afterResult: () =>
      ctx.sendCall("NotifyReport", {
        requestId: req.requestId,
        generatedAt: new Date().toISOString(),
        seqNo: 0,
        tbc: false,
        reportData: [first, ...reportData.slice(1)],
      }),
  };
}

export function handleGetReportV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  const req = payload as GetReportRequestV201;
  let reportData = buildBaseReportData(
    ctx.chargePoint.configuration,
    ctx.chargePoint.connectors.keys(),
    ctx.chargePoint.deviceModelTargets,
  );

  if (req.componentVariable && req.componentVariable.length > 0) {
    const wanted = req.componentVariable;
    reportData = reportData.filter((rd) =>
      wanted.some(
        (cv) =>
          cv.component.name === rd.component.name &&
          // B08.FR.11 (#538): an EVSE (and connector) in the filter.
          (cv.component.evse === undefined ||
            (cv.component.evse.id === rd.component.evse?.id &&
              (cv.component.evse.connectorId === undefined ||
                cv.component.evse.connectorId ===
                  rd.component.evse?.connectorId))) &&
          (cv.variable?.name === undefined ||
            cv.variable.name === rd.variable?.name),
      ),
    );
  }

  // componentCriteria is ignored because the flat configuration store does not
  // model Active/Available/Enabled/Problem state.
  const first = reportData[0];
  if (first === undefined) {
    return {
      response: {
        status: "EmptyResultSet",
      } satisfies GetReportResponseV201,
    };
  }

  return {
    response: { status: "Accepted" } satisfies GetReportResponseV201,
    afterResult: () =>
      ctx.sendCall("NotifyReport", {
        requestId: req.requestId,
        generatedAt: new Date().toISOString(),
        seqNo: 0,
        tbc: false,
        reportData: [first, ...reportData.slice(1)],
      }),
  };
}

export function buildV201InboundRegistry(): V201InboundRegistry {
  const certificateHandlers = buildCertificateHandlersV2x(
    V201_CERTIFICATE_MAPPING,
  );
  return new Map<string, V201InboundHandler>([
    [
      "GetVariables",
      {
        validate: isValidGetVariablesRequestV201,
        handle: (p, ctx) => ({
          response: handleGetVariablesV201(
            p as GetVariablesRequestV201,
            ctx.chargePoint.configuration,
            {
              evseExists: (evse) => evseOf(ctx, evse),
              targets: ctx.chargePoint.deviceModelTargets,
            },
          ),
        }),
      },
    ],
    [
      "SetVariables",
      {
        validate: isValidSetVariablesRequestV201,
        handle: (p, ctx) => ({
          response: handleSetVariablesV201(
            p as SetVariablesRequestV201,
            ctx.chargePoint.configuration,
            {
              evseExists: (evse) => evseOf(ctx, evse),
              targets: ctx.chargePoint.deviceModelTargets,
            },
          ),
        }),
      },
    ],
    [
      "GetBaseReport",
      {
        validate: isValidGetBaseReportRequestV201,
        handle: handleGetBaseReportV201,
      },
    ],
    [
      "RequestStartTransaction",
      {
        validate: isValidRequestStartTransactionRequestV201,
        handle: handleRequestStartTransactionV201,
      },
    ],
    [
      "RequestStopTransaction",
      {
        validate: isValidRequestStopTransactionRequestV201,
        handle: handleRequestStopTransactionV201,
      },
    ],
    [
      "GetTransactionStatus",
      {
        validate: isValidGetTransactionStatusRequestV201,
        handle: handleGetTransactionStatusV201,
      },
    ],
    [
      "Reset",
      {
        validate: isValidResetRequestV201,
        handle: handleResetV201,
      },
    ],
    [
      "ChangeAvailability",
      {
        validate: isValidChangeAvailabilityRequestV201,
        handle: handleChangeAvailabilityV201,
      },
    ],
    [
      "UnlockConnector",
      {
        validate: isValidUnlockConnectorRequestV201,
        handle: handleUnlockConnectorV201,
      },
    ],
    [
      "TriggerMessage",
      {
        validate: isValidTriggerMessageRequestV201,
        handle: handleTriggerMessageV201,
      },
    ],
    [
      "ClearCache",
      {
        validate: isValidClearCacheRequestV201,
        handle: handleClearCacheV201,
      },
    ],
    [
      "ReserveNow",
      {
        validate: isValidReserveNowRequestV201,
        handle: handleReserveNowV201,
      },
    ],
    [
      "CancelReservation",
      {
        validate: isValidCancelReservationRequestV201,
        handle: handleCancelReservationV201,
      },
    ],
    [
      "SetChargingProfile",
      {
        validate: isValidSetChargingProfileRequestV201,
        handle: handleSetChargingProfileV201,
      },
    ],
    [
      "ClearChargingProfile",
      {
        validate: isValidClearChargingProfileRequestV201,
        handle: handleClearChargingProfileV201,
      },
    ],
    [
      "GetChargingProfiles",
      {
        validate: isValidGetChargingProfilesRequestV201,
        handle: handleGetChargingProfilesV201,
      },
    ],
    [
      "GetCompositeSchedule",
      {
        validate: isValidGetCompositeScheduleRequestV201,
        handle: handleGetCompositeScheduleV201,
      },
    ],
    [
      "GetReport",
      {
        validate: isValidGetReportRequestV201,
        handle: handleGetReportV201,
      },
    ],
    [
      "GetMonitoringReport",
      {
        validate: isValidGetMonitoringReportRequestV201,
        handle: createGetMonitoringReportHandlerV201("v201"),
      },
    ],
    [
      "SetMonitoringBase",
      {
        validate: isValidSetMonitoringBaseRequestV201,
        handle: (p, ctx) => ({
          response: {
            status: ctx.chargePoint.monitoring.applyMonitoringBase(
              (p as SetMonitoringBaseRequestV201).monitoringBase,
            ),
          } satisfies SetMonitoringBaseResponseV201,
        }),
      },
    ],
    [
      "SetMonitoringLevel",
      {
        validate: isValidSetMonitoringLevelRequestV201,
        handle: (p, ctx) => ({
          response: handleSetMonitoringLevelV201(
            p as SetMonitoringLevelRequestV201,
            ctx.chargePoint.monitoring,
          ),
        }),
      },
    ],
    [
      "SetNetworkProfile",
      {
        validate: isValidSetNetworkProfileRequestV201,
        handle: handleSetNetworkProfileAckV201,
      },
    ],
    [
      "SendLocalList",
      {
        validate: isValidSendLocalListRequestV201,
        handle: handleSendLocalListAckV201,
      },
    ],
    [
      "GetLog",
      {
        validate: isValidGetLogRequestV201,
        handle: handleGetLogAckV201,
      },
    ],
    [
      "SetDisplayMessage",
      {
        validate: isValidSetDisplayMessageRequestV201,
        handle: handleSetDisplayMessageAckV201,
      },
    ],
    [
      "GetDisplayMessages",
      {
        validate: isValidGetDisplayMessagesRequestV201,
        handle: handleGetDisplayMessagesAckV201,
      },
    ],
    [
      "ClearDisplayMessage",
      {
        validate: isValidClearDisplayMessageRequestV201,
        handle: handleClearDisplayMessageAckV201,
      },
    ],
    [
      "CustomerInformation",
      {
        validate: isValidCustomerInformationRequestV201,
        handle: handleCustomerInformationAckV201,
      },
    ],
    [
      "DataTransfer",
      {
        validate: isValidDataTransferRequestV201,
        handle: handleDataTransferAckV201,
      },
    ],
    [
      "CertificateSigned",
      {
        validate: isValidCertificateSignedRequestV201,
        handle: certificateHandlers.CertificateSigned,
      },
    ],
    [
      "DeleteCertificate",
      {
        validate: isValidDeleteCertificateRequestV201,
        handle: certificateHandlers.DeleteCertificate,
      },
    ],
    [
      "GetInstalledCertificateIds",
      {
        validate: isValidGetInstalledCertificateIdsRequestV201,
        handle: certificateHandlers.GetInstalledCertificateIds,
      },
    ],
    [
      "InstallCertificate",
      {
        validate: isValidInstallCertificateRequestV201,
        handle: certificateHandlers.InstallCertificate,
      },
    ],
    [
      "PublishFirmware",
      {
        validate: isValidPublishFirmwareRequestV201,
        handle: handlePublishFirmwareAckV201,
      },
    ],
    [
      "UnpublishFirmware",
      {
        validate: isValidUnpublishFirmwareRequestV201,
        handle: handleUnpublishFirmwareAckV201,
      },
    ],
    [
      "UpdateFirmware",
      {
        validate: isValidUpdateFirmwareRequestV201,
        handle: handleUpdateFirmwareAckV201,
      },
    ],
    [
      "GetLocalListVersion",
      {
        validate: isValidGetLocalListVersionRequestV201,
        handle: handleGetLocalListVersionAckV201,
      },
    ],
    [
      "CostUpdated",
      {
        validate: isValidCostUpdatedRequestV201,
        handle: handleCostUpdatedAckV201,
      },
    ],
    [
      "SetVariableMonitoring",
      {
        validate: isValidSetVariableMonitoringRequestV201,
        handle: (p, ctx) => ({
          response: handleSetVariableMonitoringV201(
            p as SetVariableMonitoringRequestV201,
            ctx.chargePoint.monitoring,
            ctx.chargePoint.configuration,
            (evse) => evseOf(ctx, evse),
            ctx.chargePoint.deviceModelTargets,
          ),
        }),
      },
    ],
    [
      "ClearVariableMonitoring",
      {
        validate: isValidClearVariableMonitoringRequestV201,
        handle: (p, ctx) => ({
          response: handleClearVariableMonitoringV201(
            p as ClearVariableMonitoringRequestV201,
            ctx.chargePoint.monitoring,
          ),
        }),
      },
    ],
  ]);
}
