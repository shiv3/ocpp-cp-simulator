/** Commands that act on one registered charge point (connection, OCPP calls, transactions, notifications, meter values): split out of LocalChargePointService (#877). */
import type { ResponseOverrideRequest } from "@ocpp-cp-simulator/core/cp/domain/charge-point/responseOverrideRequest";
import type {
  AuthorizationCacheSeedEntry,
  AuthorizationCacheView,
} from "@ocpp-cp-simulator/core/cp/domain/auth/AuthorizationCacheSeed";
import {
  DIAGNOSTICS_STATUSES,
  FIRMWARE_STATUSES,
  UPLOAD_LOG_STATUSES,
  type DiagnosticsStatus,
  type FirmwareStatus,
  type UploadLogStatus,
} from "@ocpp-cp-simulator/core/cp/domain/types/FirmwareLogStatus";
import type {
  DataTransferData,
  DataTransferResult,
} from "@ocpp-cp-simulator/core/cp/domain/types/DataTransfer";
import type {
  OcppCallOutcome,
  OcppCallRequest,
  RawFrameOutcome,
  RawFrameRequest,
  CallResultErrorOutcome,
  CallResultErrorRequest,
  OcppSendOutcome,
  OcppSendRequest,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppCall";
import type {
  Get15118EVCertificateRequest,
  Get15118EVCertificateResult,
} from "@ocpp-cp-simulator/core/cp/domain/security/get15118EVCertificate";
import {
  splitStopReason,
  type MeterReadingContext,
  type StartTransactionCommandOptions,
  type IdTokenTypeName,
  type StopTransactionCommandOptions,
  type TransactionUpdateOptions,
} from "@ocpp-cp-simulator/core/cp/domain/connector/Transaction";
import { requireStatus } from "./snapshotMapping";
import type { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import {
  hasStatusNotificationOptions,
  type StatusNotificationOptions,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import {
  getExistingChargePointOrThrow,
  type LocalServiceHost,
} from "./localHost";

export async function reset(host: LocalServiceHost, id: string): Promise<void> {
  getExistingChargePointOrThrow(host.chargePoints, id).reset();
}

export async function sendHeartbeat(
  host: LocalServiceHost,
  id: string,
): Promise<void> {
  getExistingChargePointOrThrow(host.chargePoints, id).sendHeartbeat();
}

export async function startHeartbeat(
  host: LocalServiceHost,
  id: string,
  intervalSeconds: number,
): Promise<void> {
  getExistingChargePointOrThrow(host.chargePoints, id).startHeartbeat(
    intervalSeconds,
  );
}

export async function stopHeartbeat(
  host: LocalServiceHost,
  id: string,
): Promise<void> {
  getExistingChargePointOrThrow(host.chargePoints, id).stopHeartbeat();
}

export async function authorize(
  host: LocalServiceHost,
  id: string,
  tagId: string,
  idTokenType?: IdTokenTypeName,
): Promise<void> {
  getExistingChargePointOrThrow(host.chargePoints, id).authorize(
    tagId,
    idTokenType,
  );
}

export async function sendDataTransfer(
  host: LocalServiceHost,
  id: string,
  vendorId: string,
  messageId?: string,
  data?: DataTransferData,
): Promise<DataTransferResult> {
  return getExistingChargePointOrThrow(host.chargePoints, id).sendDataTransfer(
    vendorId,
    messageId,
    data,
  );
}

export async function sendOcppCall(
  host: LocalServiceHost,
  id: string,
  request: OcppCallRequest,
): Promise<OcppCallOutcome> {
  return getExistingChargePointOrThrow(host.chargePoints, id).sendOcppCall(
    request,
  );
}

export async function sendOcppSend(
  host: LocalServiceHost,
  id: string,
  request: OcppSendRequest,
): Promise<OcppSendOutcome> {
  return getExistingChargePointOrThrow(host.chargePoints, id).sendOcppSend(
    request,
  );
}

export async function sendRawFrame(
  host: LocalServiceHost,
  id: string,
  request: RawFrameRequest,
): Promise<RawFrameOutcome> {
  return getExistingChargePointOrThrow(host.chargePoints, id).sendRawFrame(
    request,
  );
}

export async function setResponseOverride(
  host: LocalServiceHost,
  id: string,
  request: ResponseOverrideRequest,
): Promise<{ action: string; mode: string }> {
  const spec = getExistingChargePointOrThrow(
    host.chargePoints,
    id,
  ).setResponseOverride(request);
  return { action: request.action, mode: spec.mode };
}

export async function clearResponseOverrides(
  host: LocalServiceHost,
  id: string,
  action?: string,
): Promise<number> {
  return getExistingChargePointOrThrow(
    host.chargePoints,
    id,
  ).clearResponseOverrides(action);
}

export async function sendCallResultError(
  host: LocalServiceHost,
  id: string,
  request: CallResultErrorRequest,
): Promise<CallResultErrorOutcome> {
  return getExistingChargePointOrThrow(
    host.chargePoints,
    id,
  ).sendCallResultError(request);
}

export async function get15118EVCertificate(
  host: LocalServiceHost,
  id: string,
  request: Get15118EVCertificateRequest,
): Promise<Get15118EVCertificateResult> {
  return getExistingChargePointOrThrow(
    host.chargePoints,
    id,
  ).get15118EVCertificate(request);
}

export async function getAuthorizationCache(
  host: LocalServiceHost,
  id: string,
): Promise<AuthorizationCacheView> {
  return getExistingChargePointOrThrow(
    host.chargePoints,
    id,
  ).authorization.cacheView();
}

export async function seedAuthorizationCache(
  host: LocalServiceHost,
  id: string,
  entries: readonly AuthorizationCacheSeedEntry[],
): Promise<number> {
  const seeded = getExistingChargePointOrThrow(
    host.chargePoints,
    id,
  ).authorization.seedCache(entries);
  await host.database?.flush?.();
  return seeded;
}

export async function clearAuthorizationCache(
  host: LocalServiceHost,
  id: string,
): Promise<boolean> {
  const cleared = getExistingChargePointOrThrow(
    host.chargePoints,
    id,
  ).clearAuthorizationCache();
  await host.database?.flush?.();
  return cleared;
}

export async function startTransaction(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  tagId: string,
  options: StartTransactionCommandOptions = {},
): Promise<void> {
  getExistingChargePointOrThrow(host.chargePoints, id).startTransaction(
    tagId,
    connectorId,
    undefined,
    undefined,
    options,
  );
}

export async function stopTransaction(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  options: StopTransactionCommandOptions = {},
): Promise<void> {
  const { stopReason, stoppedReason } = splitStopReason(options.reason);
  getExistingChargePointOrThrow(host.chargePoints, id).stopTransaction(
    connectorId,
    stopReason,
    { triggerReason: options.triggerReason, stoppedReason },
  );
}

export async function sendTransactionUpdate(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  options: TransactionUpdateOptions,
): Promise<void> {
  getExistingChargePointOrThrow(host.chargePoints, id).sendTransactionUpdate(
    connectorId,
    options,
  );
}

export async function evDisconnected(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
): Promise<void> {
  getExistingChargePointOrThrow(host.chargePoints, id).evDisconnected(
    connectorId,
  );
}

export async function evPlugIn(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
): Promise<void> {
  getExistingChargePointOrThrow(host.chargePoints, id).evPlugIn(connectorId);
}

export async function evSetReady(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  ready: boolean,
): Promise<void> {
  getExistingChargePointOrThrow(host.chargePoints, id).evSetReady(
    connectorId,
    ready,
  );
}

export async function sendStatusNotification(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  status: OCPPStatus,
  opts?: StatusNotificationOptions,
): Promise<void> {
  const cp = getExistingChargePointOrThrow(host.chargePoints, id);
  const allowInvalidTransition = opts?.allowInvalidTransition === true;
  if (hasStatusNotificationOptions(opts)) {
    // Use the raw sender so errorCode/info ride along with the
    // StatusNotification.req without mutating the connector's runtime
    // status field.
    cp.sendStatusNotificationRaw(connectorId, status, opts);
    return;
  }
  if (allowInvalidTransition) {
    cp.updateConnectorStatus(connectorId, status, {
      allowInvalidTransition: true,
    });
    return;
  }
  cp.updateConnectorStatus(connectorId, status);
}

export async function sendDiagnosticsStatusNotification(
  host: LocalServiceHost,
  id: string,
  status: DiagnosticsStatus,
): Promise<void> {
  requireStatus(status, DIAGNOSTICS_STATUSES);
  getExistingChargePointOrThrow(
    host.chargePoints,
    id,
  ).sendDiagnosticsStatusNotification(status);
}

export async function sendFirmwareStatusNotification(
  host: LocalServiceHost,
  id: string,
  status: FirmwareStatus,
  requestId?: number,
): Promise<void> {
  requireStatus(status, FIRMWARE_STATUSES);
  const chargePoint = getExistingChargePointOrThrow(host.chargePoints, id);
  // Two-argument form only when a requestId was given (same as the
  // registry service): the 1.6-era call shape is unchanged.
  if (requestId === undefined) {
    chargePoint.sendFirmwareStatusNotification(status);
  } else {
    chargePoint.sendFirmwareStatusNotification(status, requestId);
  }
}

export async function sendLogStatusNotification(
  host: LocalServiceHost,
  id: string,
  status: UploadLogStatus,
  requestId?: number,
): Promise<void> {
  requireStatus(status, UPLOAD_LOG_STATUSES);
  getExistingChargePointOrThrow(
    host.chargePoints,
    id,
  ).sendLogStatusNotification(status, requestId);
}

export async function sendSecurityEventNotification(
  host: LocalServiceHost,
  id: string,
  type: string,
  techInfo?: string,
): Promise<void> {
  await getExistingChargePointOrThrow(
    host.chargePoints,
    id,
  ).sendSecurityEventNotification(type, techInfo);
}

export async function sendSignCertificate(
  host: LocalServiceHost,
  id: string,
  csr?: string,
): Promise<void> {
  await getExistingChargePointOrThrow(
    host.chargePoints,
    id,
  ).sendSignCertificate(csr);
}

export async function setMeterValue(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  value: number,
): Promise<void> {
  getExistingChargePointOrThrow(host.chargePoints, id).setMeterValue(
    connectorId,
    value,
  );
}

export async function sendMeterValue(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  context?: MeterReadingContext,
): Promise<void> {
  getExistingChargePointOrThrow(host.chargePoints, id).sendMeterValue(
    connectorId,
    context,
  );
}

export async function removeConnector(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
): Promise<void> {
  getExistingChargePointOrThrow(host.chargePoints, id).removeConnector(
    connectorId,
  );
}
