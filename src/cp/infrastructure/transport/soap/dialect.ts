import type { OcppVersion } from "../../../domain/types/OcppVersion";
import {
  OCPP_1_2,
  OCPP_1_5,
  OCPP_1_6_SOAP,
} from "../../../domain/types/OcppVersion";
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
  "ClearChargingProfile",
  "GetCompositeSchedule",
  "GetConfiguration",
  "GetDiagnostics",
  "GetLocalListVersion",
  "RemoteStartTransaction",
  "RemoteStopTransaction",
  "ReserveNow",
  "Reset",
  "SendLocalList",
  "SetChargingProfile",
  "TriggerMessage",
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
    // DataTransfer exists in both CS→CP and CP→CS directions with the same wrapper name
    // but different namespaces. Mark as bidirectional so parseSoapEnvelope can handle both.
    DataTransfer: {
      ...cs("DataTransfer"),
      bidirectional: true,
    },
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

export const OCPP12_SOAP_NAMESPACES = {
  CS: "urn://Ocpp/Cs/2010/08/",
  CP: "urn://Ocpp/Cp/2010/08/",
  SOAP12: SOAP12_NAMESPACE,
  WSA: WSA_NAMESPACE,
} as const;

function buildOcpp12OperationMetadata(): Readonly<
  Partial<Record<SoapOperation, SoapOperationMetadata>>
> {
  const ns = OCPP12_SOAP_NAMESPACES;
  const cs = (name: SoapOperation, overrides?: OperationMetadataOverrides) =>
    operationMetadataFor(name, ns.CS, "cs", overrides);
  const cp = (name: SoapOperation) => operationMetadataFor(name, ns.CP, "cp");
  return {
    // CP → CS (9 operations; no DataTransfer in 1.2)
    Authorize: cs("Authorize"),
    BootNotification: cs("BootNotification", {
      requestFieldOrder: BOOT_NOTIFICATION_REQUEST_FIELD_ORDER,
      responseFieldOrder: ["status", "currentTime", "heartbeatInterval"],
    }),
    DiagnosticsStatusNotification: cs("DiagnosticsStatusNotification"),
    FirmwareStatusNotification: cs("FirmwareStatusNotification"),
    Heartbeat: cs("Heartbeat"),
    MeterValues: cs("MeterValues"),
    StartTransaction: cs("StartTransaction"),
    StatusNotification: cs("StatusNotification"),
    StopTransaction: cs("StopTransaction"),
    // CS → CP (9 operations; no GetConfiguration, ReserveNow, CancelReservation,
    // SendLocalList, GetLocalListVersion in 1.2)
    ChangeAvailability: cp("ChangeAvailability"),
    ChangeConfiguration: cp("ChangeConfiguration"),
    ClearCache: cp("ClearCache"),
    GetDiagnostics: cp("GetDiagnostics"),
    RemoteStartTransaction: cp("RemoteStartTransaction"),
    RemoteStopTransaction: cp("RemoteStopTransaction"),
    Reset: cp("Reset"),
    UnlockConnector: cp("UnlockConnector"),
    UpdateFirmware: cp("UpdateFirmware"),
  };
}

export const OCPP12_DIALECT: SoapDialect = {
  version: OCPP_1_2,
  namespaces: OCPP12_SOAP_NAMESPACES,
  operationMetadata: buildOcpp12OperationMetadata(),
};

export const OCPP16_SOAP_NAMESPACES = {
  CS: "urn://Ocpp/Cs/2015/10/",
  CP: "urn://Ocpp/Cp/2015/10/",
  SOAP12: SOAP12_NAMESPACE,
  WSA: WSA_NAMESPACE,
} as const;

/**
 * OCPP 1.6 SOAP field orders for wire-format sequences. XSD order matters:
 * SteVe JAXB bindings are sequence-sensitive and reject messages with fields
 * in the wrong order.
 *
 * Verified against: https://raw.githubusercontent.com/steve-community/ocpp-jaxb/master/ocpp-jaxb/src/main/resources/wsdl/OCPP_CentralSystemService_1.6.wsdl
 * (Fetched 2026-07-11)
 *
 * StatusNotificationRequest: connectorId, status, errorCode, info?, timestamp?, vendorId?, vendorErrorCode?
 * StartTransactionRequest: connectorId, idTag, timestamp, meterStart, reservationId?
 * StopTransactionRequest: transactionId, idTag?, timestamp, meterStop, reason?, transactionData?
 * MeterValuesRequest: connectorId, transactionId?, meterValue[]
 * MeterValue (within meterValuesRequest): timestamp, sampledValue[]
 * SampledValue (within meterValue): value, context?, format?, measurand?, phase?, location?, unit?
 * AuthorizeRequest: idTag
 * DataTransferRequest: vendorId, messageId?, data?
 * DiagnosticsStatusNotificationRequest: status
 * FirmwareStatusNotificationRequest: status
 */
const STATUS_NOTIFICATION_REQUEST_FIELD_ORDER = [
  "connectorId",
  "status",
  "errorCode",
  "info",
  "timestamp",
  "vendorId",
  "vendorErrorCode",
] as const;

const START_TRANSACTION_REQUEST_FIELD_ORDER = [
  "connectorId",
  "idTag",
  "timestamp",
  "meterStart",
  "reservationId",
] as const;

const STOP_TRANSACTION_REQUEST_FIELD_ORDER = [
  "transactionId",
  "idTag",
  "timestamp",
  "meterStop",
  "reason",
  "transactionData",
] as const;

const METER_VALUES_REQUEST_FIELD_ORDER = [
  "connectorId",
  "transactionId",
  "meterValue",
] as const;

function buildOcpp16OperationMetadata(): Readonly<
  Partial<Record<SoapOperation, SoapOperationMetadata>>
> {
  const ns = OCPP16_SOAP_NAMESPACES;
  const cs = (name: SoapOperation, overrides?: OperationMetadataOverrides) =>
    operationMetadataFor(name, ns.CS, "cs", overrides);
  const cp = (name: SoapOperation) => operationMetadataFor(name, ns.CP, "cp");
  return {
    // CP → CS (10 operations; includes DataTransfer)
    Authorize: cs("Authorize"),
    BootNotification: cs("BootNotification", {
      requestFieldOrder: BOOT_NOTIFICATION_REQUEST_FIELD_ORDER,
      responseFieldOrder: ["status", "currentTime", "heartbeatInterval"],
    }),
    // DataTransfer exists in both CS→CP and CP→CS directions with the same wrapper name
    // but different namespaces. Mark as bidirectional so parseSoapEnvelope can handle both.
    DataTransfer: {
      ...cs("DataTransfer", {
        requestFieldOrder: ["vendorId", "messageId", "data"],
      }),
      bidirectional: true,
    },
    DiagnosticsStatusNotification: cs("DiagnosticsStatusNotification"),
    FirmwareStatusNotification: cs("FirmwareStatusNotification"),
    Heartbeat: cs("Heartbeat"),
    MeterValues: cs("MeterValues", {
      requestFieldOrder: METER_VALUES_REQUEST_FIELD_ORDER,
    }),
    StartTransaction: cs("StartTransaction", {
      requestFieldOrder: START_TRANSACTION_REQUEST_FIELD_ORDER,
    }),
    StatusNotification: cs("StatusNotification", {
      requestFieldOrder: STATUS_NOTIFICATION_REQUEST_FIELD_ORDER,
    }),
    StopTransaction: cs("StopTransaction", {
      requestFieldOrder: STOP_TRANSACTION_REQUEST_FIELD_ORDER,
    }),
    // CS → CP (19 operations; the 1.5 fourteen + four 1.6-only + DataTransfer)
    CancelReservation: cp("CancelReservation"),
    ChangeAvailability: cp("ChangeAvailability"),
    ChangeConfiguration: cp("ChangeConfiguration"),
    ClearCache: cp("ClearCache"),
    ClearChargingProfile: cp("ClearChargingProfile"),
    GetCompositeSchedule: cp("GetCompositeSchedule"),
    GetConfiguration: cp("GetConfiguration"),
    GetDiagnostics: cp("GetDiagnostics"),
    GetLocalListVersion: cp("GetLocalListVersion"),
    RemoteStartTransaction: cp("RemoteStartTransaction"),
    RemoteStopTransaction: cp("RemoteStopTransaction"),
    ReserveNow: cp("ReserveNow"),
    Reset: cp("Reset"),
    SendLocalList: cp("SendLocalList"),
    SetChargingProfile: cp("SetChargingProfile"),
    TriggerMessage: cp("TriggerMessage"),
    UnlockConnector: cp("UnlockConnector"),
    UpdateFirmware: cp("UpdateFirmware"),
  };
}

export const OCPP16_DIALECT: SoapDialect = {
  version: OCPP_1_6_SOAP,
  namespaces: OCPP16_SOAP_NAMESPACES,
  operationMetadata: buildOcpp16OperationMetadata(),
};

export function soapDialectForVersion(
  version: string | OcppVersion,
): SoapDialect {
  if (version === OCPP_1_2) {
    return OCPP12_DIALECT;
  }
  if (version === OCPP_1_5) {
    return OCPP15_DIALECT;
  }
  if (version === OCPP_1_6_SOAP) {
    return OCPP16_DIALECT;
  }
  throw new Error(`SOAP dialect not available for version: ${version}`);
}
