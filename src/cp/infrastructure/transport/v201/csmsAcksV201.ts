// Tier-3 schema-valid responses for the remaining CSMS-initiated 2.0.1 messages; honest non-Accepted statuses reflect features the simulator does not yet implement; deep behavior is a later fidelity phase.
import type {
  CertificateSignedResponseV201,
  ClearDisplayMessageResponseV201,
  ClearVariableMonitoringRequestV201,
  ClearVariableMonitoringResponseV201,
  CostUpdatedResponseV201,
  CustomerInformationResponseV201,
  DataTransferResponseV201,
  DeleteCertificateResponseV201,
  GetDisplayMessagesResponseV201,
  GetInstalledCertificateIdsResponseV201,
  GetLocalListVersionResponseV201,
  GetLogResponseV201,
  GetMonitoringReportResponseV201,
  InstallCertificateResponseV201,
  PublishFirmwareResponseV201,
  SendLocalListRequestV201,
  SendLocalListResponseV201,
  SetDisplayMessageResponseV201,
  SetMonitoringBaseResponseV201,
  SetMonitoringLevelResponseV201,
  SetNetworkProfileResponseV201,
  SetVariableMonitoringRequestV201,
  SetVariableMonitoringResponseV201,
  UnpublishFirmwareResponseV201,
  UpdateFirmwareResponseV201,
} from "../../../../ocpp";
import type {
  V201HandlerResult,
  V201InboundContext,
} from "./inboundRegistryV201";
import type {
  LocalAuthorizationEntry,
  SendLocalListItem,
  SendLocalListStatus,
} from "../../../domain/auth/LocalAuthList";
import type { AuthorizationStatusEnumType } from "../../../../ocpp/v201/types/send-local-list-request";
import type { SendLocalListStatusEnumType } from "../../../../ocpp/v201/types/send-local-list-response";

type V201AckHandler = (
  payload: unknown,
  ctx: V201InboundContext,
) => V201HandlerResult;

type SetMonitoringResult =
  SetVariableMonitoringResponseV201["setMonitoringResult"][number];
type SetMonitoringResultTuple =
  SetVariableMonitoringResponseV201["setMonitoringResult"];
type ClearMonitoringResult =
  ClearVariableMonitoringResponseV201["clearMonitoringResult"][number];
type ClearMonitoringResultTuple =
  ClearVariableMonitoringResponseV201["clearMonitoringResult"];
type DomainAuthStatus = LocalAuthorizationEntry["status"];

function toDomainAuthStatus(s: AuthorizationStatusEnumType): DomainAuthStatus {
  switch (s) {
    case "Accepted":
    case "Blocked":
    case "Expired":
    case "Invalid":
    case "ConcurrentTx":
      return s;
    case "NoCredit":
    case "NotAllowedTypeEVSE":
    case "NotAtThisLocation":
    case "NotAtThisTime":
    case "Unknown":
      return "Invalid";
  }
}

function toV201SendLocalListStatus(
  s: SendLocalListStatus,
): SendLocalListStatusEnumType {
  switch (s) {
    case "Accepted":
    case "Failed":
    case "VersionMismatch":
      return s;
    case "NotSupported":
      return "Failed";
  }
}

export const handleGetMonitoringReportAckV201 = (() => ({
  response: {
    status: "EmptyResultSet",
  } satisfies GetMonitoringReportResponseV201,
})) satisfies V201AckHandler;

export const handleSetMonitoringBaseAckV201 = (() => ({
  response: {
    status: "NotSupported",
  } satisfies SetMonitoringBaseResponseV201,
})) satisfies V201AckHandler;

export const handleSetMonitoringLevelAckV201 = (() => ({
  response: {
    status: "Rejected",
  } satisfies SetMonitoringLevelResponseV201,
})) satisfies V201AckHandler;

export const handleSetNetworkProfileAckV201 = (() => ({
  response: {
    status: "Rejected",
  } satisfies SetNetworkProfileResponseV201,
})) satisfies V201AckHandler;

export const handleSendLocalListAckV201 = ((
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult => {
  const req = payload as SendLocalListRequestV201;
  const cp = ctx.chargePoint;
  if (!cp.configuration.localAuthListEnabled()) {
    return {
      response: {
        status: "Failed",
      } satisfies SendLocalListResponseV201,
    };
  }

  const limits = {
    localAuthListMaxLength: cp.configuration.localAuthListMaxLength(),
    sendLocalListMaxLength: cp.configuration.sendLocalListMaxLength(),
  };
  const items: SendLocalListItem[] | undefined =
    req.localAuthorizationList?.map((ad) => ({
      idTag: ad.idToken.idToken,
      idTagInfo: ad.idTokenInfo
        ? { status: toDomainAuthStatus(ad.idTokenInfo.status) }
        : undefined,
    }));
  const status =
    req.updateType === "Full"
      ? cp.localAuthListManager.applyFull(req.versionNumber, items, limits)
      : cp.localAuthListManager.applyDifferential(
          req.versionNumber,
          items,
          limits,
        );

  return {
    response: {
      status: toV201SendLocalListStatus(status),
    } satisfies SendLocalListResponseV201,
  };
}) satisfies V201AckHandler;

export const handleGetLogAckV201 = (() => ({
  response: {
    status: "Rejected",
  } satisfies GetLogResponseV201,
})) satisfies V201AckHandler;

export const handleSetDisplayMessageAckV201 = (() => ({
  response: {
    status: "Rejected",
  } satisfies SetDisplayMessageResponseV201,
})) satisfies V201AckHandler;

export const handleGetDisplayMessagesAckV201 = (() => ({
  response: {
    status: "Unknown",
  } satisfies GetDisplayMessagesResponseV201,
})) satisfies V201AckHandler;

export const handleClearDisplayMessageAckV201 = (() => ({
  response: {
    status: "Unknown",
  } satisfies ClearDisplayMessageResponseV201,
})) satisfies V201AckHandler;

export const handleCustomerInformationAckV201 = (() => ({
  response: {
    status: "Rejected",
  } satisfies CustomerInformationResponseV201,
})) satisfies V201AckHandler;

export const handleDataTransferAckV201 = (() => ({
  response: {
    status: "UnknownVendorId",
  } satisfies DataTransferResponseV201,
})) satisfies V201AckHandler;

export const handleCertificateSignedAckV201 = (() => ({
  response: {
    status: "Rejected",
  } satisfies CertificateSignedResponseV201,
})) satisfies V201AckHandler;

export const handleDeleteCertificateAckV201 = (() => ({
  response: {
    status: "NotFound",
  } satisfies DeleteCertificateResponseV201,
})) satisfies V201AckHandler;

export const handleGetInstalledCertificateIdsAckV201 = (() => ({
  response: {
    status: "NotFound",
  } satisfies GetInstalledCertificateIdsResponseV201,
})) satisfies V201AckHandler;

export const handleInstallCertificateAckV201 = (() => ({
  response: {
    status: "Rejected",
  } satisfies InstallCertificateResponseV201,
})) satisfies V201AckHandler;

export const handlePublishFirmwareAckV201 = (() => ({
  response: {
    status: "Rejected",
  } satisfies PublishFirmwareResponseV201,
})) satisfies V201AckHandler;

export const handleUnpublishFirmwareAckV201 = (() => ({
  response: {
    status: "NoFirmware",
  } satisfies UnpublishFirmwareResponseV201,
})) satisfies V201AckHandler;

export const handleUpdateFirmwareAckV201 = (() => ({
  response: {
    status: "Rejected",
  } satisfies UpdateFirmwareResponseV201,
})) satisfies V201AckHandler;

export const handleGetLocalListVersionAckV201 = ((
  _payload?: unknown,
  ctx?: V201InboundContext,
): V201HandlerResult => {
  if (ctx === undefined) {
    return {
      response: {
        versionNumber: 0,
      } satisfies GetLocalListVersionResponseV201,
    };
  }

  const cp = ctx.chargePoint;
  if (!cp.configuration.localAuthListEnabled()) {
    return {
      response: {
        versionNumber: -1,
      } satisfies GetLocalListVersionResponseV201,
    };
  }

  return {
    response: {
      versionNumber: cp.localAuthListManager.getVersion(),
    } satisfies GetLocalListVersionResponseV201,
  };
}) satisfies V201AckHandler;

export const handleCostUpdatedAckV201 = (() => ({
  response: {} satisfies CostUpdatedResponseV201,
})) satisfies V201AckHandler;

export const handleSetVariableMonitoringAckV201 = ((p: unknown) => {
  const req = p as SetVariableMonitoringRequestV201;
  const results: SetMonitoringResult[] = req.setMonitoringData.map(
    (d): SetMonitoringResult => ({
      status: "Rejected",
      type: d.type,
      component: d.component,
      variable: d.variable,
      severity: d.severity,
    }),
  );

  return {
    response: {
      setMonitoringResult: results as SetMonitoringResultTuple,
    } satisfies SetVariableMonitoringResponseV201,
  };
}) satisfies V201AckHandler;

export const handleClearVariableMonitoringAckV201 = ((p: unknown) => {
  const req = p as ClearVariableMonitoringRequestV201;
  const results: ClearMonitoringResult[] = req.id.map(
    (id): ClearMonitoringResult => ({
      status: "NotFound",
      id,
    }),
  );

  return {
    response: {
      clearMonitoringResult: results as ClearMonitoringResultTuple,
    } satisfies ClearVariableMonitoringResponseV201,
  };
}) satisfies V201AckHandler;
