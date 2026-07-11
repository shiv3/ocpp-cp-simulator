import type { OcppVersion } from "../../../domain/types/OcppVersion";
import { OCPP_1_5 } from "../../../domain/types/OcppVersion";
import type { SoapOperationMetadata } from "./soapEnvelope";

// Shared SOAP and WS-Addressing namespaces (dialect-independent)
export const SOAP12_NAMESPACE = "http://www.w3.org/2003/05/soap-envelope";
export const WSA_NAMESPACE = "http://www.w3.org/2005/08/addressing";

/**
 * Union of every SOAP operation any OCPP SOAP dialect defines. Each dialect
 * exposes its own subset via `operationMetadata`; looking up an operation
 * outside a dialect's surface fails at runtime with a clear error. Later
 * dialects (1.2 narrows, 1.6 widens with TriggerMessage/charging-profile
 * operations) extend this union.
 */
export const SOAP_OPERATION_NAMES = [
  // CP → CS (CentralSystemService)
  "Authorize",
  "BootNotification",
  "DataTransfer",
  "DiagnosticsStatusNotification",
  "FirmwareStatusNotification",
  "Heartbeat",
  "MeterValues",
  "StartTransaction",
  "StatusNotification",
  "StopTransaction",
  // CS → CP (ChargePointService)
  "CancelReservation",
  "ChangeAvailability",
  "ChangeConfiguration",
  "ClearCache",
  "GetConfiguration",
  "GetDiagnostics",
  "GetLocalListVersion",
  "RemoteStartTransaction",
  "RemoteStopTransaction",
  "ReserveNow",
  "Reset",
  "SendLocalList",
  "UnlockConnector",
  "UpdateFirmware",
] as const;

export type SoapOperation = (typeof SOAP_OPERATION_NAMES)[number];

/**
 * Everything that varies between OCPP SOAP versions (1.2 / 1.5 / 1.6): the
 * year-stamped CS/CP target namespaces and the operation surface. The SOAP
 * 1.2 + WS-Addressing envelope framing itself is shared by all dialects.
 */
export interface SoapDialect {
  readonly version: OcppVersion;
  readonly namespaces: {
    readonly CS: string;
    readonly CP: string;
  };
  readonly operationMetadata: Readonly<
    Partial<Record<SoapOperation, SoapOperationMetadata>>
  >;
}

export const OCPP15_SOAP_NAMESPACES = {
  CS: "urn://Ocpp/Cs/2012/06/",
  CP: "urn://Ocpp/Cp/2012/06/",
  SOAP12: SOAP12_NAMESPACE,
  WSA: WSA_NAMESPACE,
} as const;

export const BOOT_NOTIFICATION_REQUEST_FIELD_ORDER = [
  "chargePointVendor",
  "chargePointModel",
  "chargePointSerialNumber",
  "chargeBoxSerialNumber",
  "firmwareVersion",
  "iccid",
  "imsi",
  "meterType",
  "meterSerialNumber",
] as const;

function lowerFirst(value: string): string {
  return value.length === 0 ? value : value[0].toLowerCase() + value.slice(1);
}

type OperationMetadataOverrides = Partial<
  Pick<SoapOperationMetadata, "requestFieldOrder" | "responseFieldOrder">
>;

export function operationMetadataFor(
  operationName: SoapOperation,
  namespace: string,
  target: "cs" | "cp",
  overrides: OperationMetadataOverrides = {},
): SoapOperationMetadata {
  const wrapperBase = lowerFirst(operationName);
  return {
    action: `/${operationName}`,
    requestWrapper: `${wrapperBase}Request`,
    responseWrapper: `${wrapperBase}Response`,
    namespace,
    target,
    ...overrides,
  };
}

function buildOcpp15OperationMetadata(): Readonly<
  Partial<Record<SoapOperation, SoapOperationMetadata>>
> {
  const ns = OCPP15_SOAP_NAMESPACES;
  const cs = (name: SoapOperation, overrides?: OperationMetadataOverrides) =>
    operationMetadataFor(name, ns.CS, "cs", overrides);
  const cp = (name: SoapOperation) => operationMetadataFor(name, ns.CP, "cp");
  return {
    Authorize: cs("Authorize"),
    BootNotification: cs("BootNotification", {
      requestFieldOrder: BOOT_NOTIFICATION_REQUEST_FIELD_ORDER,
      responseFieldOrder: ["status", "currentTime", "heartbeatInterval"],
    }),
    DataTransfer: cs("DataTransfer"),
    DiagnosticsStatusNotification: cs("DiagnosticsStatusNotification"),
    FirmwareStatusNotification: cs("FirmwareStatusNotification"),
    Heartbeat: cs("Heartbeat"),
    MeterValues: cs("MeterValues"),
    StartTransaction: cs("StartTransaction"),
    StatusNotification: cs("StatusNotification"),
    StopTransaction: cs("StopTransaction"),
    CancelReservation: cp("CancelReservation"),
    ChangeAvailability: cp("ChangeAvailability"),
    ChangeConfiguration: cp("ChangeConfiguration"),
    ClearCache: cp("ClearCache"),
    GetConfiguration: cp("GetConfiguration"),
    GetDiagnostics: cp("GetDiagnostics"),
    GetLocalListVersion: cp("GetLocalListVersion"),
    RemoteStartTransaction: cp("RemoteStartTransaction"),
    RemoteStopTransaction: cp("RemoteStopTransaction"),
    ReserveNow: cp("ReserveNow"),
    Reset: cp("Reset"),
    SendLocalList: cp("SendLocalList"),
    UnlockConnector: cp("UnlockConnector"),
    UpdateFirmware: cp("UpdateFirmware"),
  };
}

export const OCPP15_DIALECT: SoapDialect = {
  version: OCPP_1_5,
  namespaces: OCPP15_SOAP_NAMESPACES,
  operationMetadata: buildOcpp15OperationMetadata(),
};

export function soapDialectForVersion(
  version: string | OcppVersion,
): SoapDialect {
  if (version === OCPP_1_5) {
    return OCPP15_DIALECT;
  }
  throw new Error(`SOAP dialect not available for version: ${version}`);
}
