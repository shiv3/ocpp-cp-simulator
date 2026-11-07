// Tier-3 schema-valid responses for the remaining CSMS-initiated 2.0.1 messages; honest non-Accepted statuses reflect features the simulator does not yet implement; deep behavior is a later fidelity phase.
import type {
  ClearDisplayMessageResponseV201,
  CostUpdatedResponseV201,
  CustomerInformationResponseV201,
  DataTransferResponseV201,
  GetDisplayMessagesResponseV201,
  GetLocalListVersionResponseV201,
  PublishFirmwareResponseV201,
  SendLocalListRequestV201,
  SendLocalListResponseV201,
  SetDisplayMessageResponseV201,
  SetNetworkProfileResponseV201,
  UnpublishFirmwareResponseV201,
} from "@ocpp-cp-sim/ocpp/index";
import type {
  V201HandlerResult,
  V201InboundContext,
} from "./inboundRegistryV201";
import type {
  LocalAuthorizationEntry,
  SendLocalListItem,
  SendLocalListStatus,
} from "../../../domain/auth/LocalAuthList";
import type { AuthorizationStatusEnumType } from "@ocpp-cp-sim/ocpp/v201/types/send-local-list-request";
import type { SendLocalListStatusEnumType } from "@ocpp-cp-sim/ocpp/v201/types/send-local-list-response";

type V201AckHandler = (
  payload: unknown,
  ctx: V201InboundContext,
) => V201HandlerResult;

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

/**
 * N01 GetLog.req (#345): translation only. The `default.logs` behavior of the
 * charger engine accepts it with a filename and remembers the `requestId` for
 * the LogStatusNotification reports the control plane drives; nothing is
 * uploaded.
 */
export const handleGetLogAckV201 = ((
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult => {
  const { response, effect } = ctx.chargePoint.engine.runDefault(
    "GetLog",
    payload,
  );
  return { response, ...(effect ? { afterResult: effect } : {}) };
}) satisfies V201AckHandler;

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

/** L03 PublishFirmware.req is for a Local Controller that serves firmware to
 *  the stations behind it. This simulated station is not one, so the request
 *  is refused — and PublishFirmwareStatusNotification is never sent (#345). */
export const handlePublishFirmwareAckV201 = (() => ({
  response: {
    status: "Rejected",
    statusInfo: {
      reasonCode: "NotLocalController",
      additionalInfo:
        "The simulated station is not a Local Controller and publishes no firmware",
    },
  } satisfies PublishFirmwareResponseV201,
})) satisfies V201AckHandler;

export const handleUnpublishFirmwareAckV201 = (() => ({
  response: {
    status: "NoFirmware",
  } satisfies UnpublishFirmwareResponseV201,
})) satisfies V201AckHandler;

/**
 * L01 UpdateFirmware.req (#345): translation only. The `default.firmware`
 * behavior of the charger engine accepts the request and remembers its
 * `requestId`; nothing is downloaded, and the reports that follow are driven
 * over the control plane (`firmware_status_notification`). A user behavior
 * can opt in to a status train.
 */
export const handleUpdateFirmwareAckV201 = ((
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult => {
  const { response, effect } = ctx.chargePoint.engine.runDefault(
    "UpdateFirmware",
    payload,
  );
  return { response, ...(effect ? { afterResult: effect } : {}) };
}) satisfies V201AckHandler;

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
