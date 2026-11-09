/**
 * Per-dialect payload builders of the SOAP client (OCPP 1.2, 1.5, 1.6 SOAP).
 * The SOAP body emits elements in object-key order, so each builder writes
 * its keys in the version's XSD sequence.
 */
import type { StartTransactionRequestV16 } from "@ocpp-cp-simulator/ocpp/index";
import type { SampledValue } from "../../../domain/connector/MeterValueBuilder";
import type { Transaction } from "../../../domain/connector/Transaction";
import type {
  ChargePointErrorCode,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";
import {
  projectStatusForVersion,
  projectErrorCodeForVersion,
} from "../../../domain/types/statusProjection";
import {
  OCPP_1_2,
  OCPP_1_5,
  OCPP_1_6_SOAP,
} from "../../../domain/types/OcppVersion";
import type { SoapPayload } from "./soapEnvelope";
import {
  soapPayload,
  toOcpp15MeterSample,
  toOcpp16SampledValue,
} from "./soapConverters";
import type {
  Ocpp12ChargePointErrorCode,
  Ocpp12ChargePointStatus,
  Ocpp12MeterValuesRequest,
  Ocpp12StartTransactionRequest,
  Ocpp12StatusNotificationRequest,
  Ocpp15ChargePointErrorCode,
  Ocpp15ChargePointStatus,
  Ocpp15MeterSample,
  Ocpp15MeterValuesRequest,
  Ocpp15StatusNotificationRequest,
  Ocpp16ChargePointErrorCode,
  Ocpp16ChargePointStatus,
  Ocpp16MeterValuesRequest,
  Ocpp16StartTransactionRequest,
  Ocpp16StatusNotificationRequest,
} from "./soapWireTypes";

/**
 * Internal seam for version-specific wire-payload construction. Allows different
 * SOAP dialects (1.2, 1.5, 1.6-SOAP later) to shape payloads differently without
 * duplicating the core request/response handling.
 */
export interface ClientWireProfile {
  toStatusNotificationRequest(
    connectorId: number,
    status: OCPPStatus,
    opts?: {
      errorCode?: ChargePointErrorCode;
      info?: string;
      vendorErrorCode?: string;
      vendorId?: string;
      timestamp?: Date;
    },
  ): SoapPayload;

  /**
   * Build the MeterValues request for this dialect, or `null` when the dialect
   * supports none of the configured measurands and the request would therefore
   * carry no samples at all. OCPP requires at least one, so the caller skips
   * the send rather than putting an empty request on the wire (#301).
   */
  toMeterValuesRequest(
    connectorId: number,
    transactionId: number | undefined,
    sampledValues: SampledValue[],
    timestamp: Date,
  ): SoapPayload | null;

  toStartTransactionRequest(
    transaction: Transaction,
    connectorId: number,
  ): SoapPayload;
}

export const OCPP15_WIRE_PROFILE: ClientWireProfile = {
  toStatusNotificationRequest(connectorId, status, opts) {
    const payload: Ocpp15StatusNotificationRequest = {
      connectorId,
      status: projectStatusForVersion(
        OCPP_1_5,
        status,
      ) as Ocpp15ChargePointStatus,
      errorCode: projectErrorCodeForVersion(
        OCPP_1_5,
        opts?.errorCode ?? "NoError",
      ) as Ocpp15ChargePointErrorCode,
      ...(opts?.info ? { info: opts.info } : {}),
      ...(opts?.timestamp ? { timestamp: opts.timestamp.toISOString() } : {}),
      ...(opts?.vendorId ? { vendorId: opts.vendorId } : {}),
      ...(opts?.vendorErrorCode
        ? { vendorErrorCode: opts.vendorErrorCode }
        : {}),
    };
    return soapPayload(payload);
  },

  toMeterValuesRequest(connectorId, transactionId, sampledValues, timestamp) {
    const value = sampledValues
      .map(toOcpp15MeterSample)
      .filter((sample): sample is Ocpp15MeterSample => sample !== null);
    // Every configured measurand was one 1.5 does not define — a connector
    // sampling only `Power.Offered` / `Current.Offered` is the reachable case
    // (#301). A 1.5 MeterValues.req must carry at least one value, so an empty
    // one would be rejected by a conforming CSMS; the caller skips the send.
    if (value.length === 0) return null;
    const payload: Ocpp15MeterValuesRequest = {
      connectorId,
      ...(transactionId !== undefined ? { transactionId } : {}),
      values: [{ timestamp: timestamp.toISOString(), value }],
    };
    return soapPayload(payload);
  },

  toStartTransactionRequest(transaction, connectorId) {
    const payload: StartTransactionRequestV16 = {
      connectorId,
      idTag: transaction.tagId,
      timestamp: transaction.startTime.toISOString(),
      meterStart: transaction.meterStart,
      ...(transaction.reservationId !== undefined
        ? { reservationId: transaction.reservationId }
        : {}),
    };
    return soapPayload(payload);
  },
};

export const OCPP12_WIRE_PROFILE: ClientWireProfile = {
  toStatusNotificationRequest(connectorId, status, opts) {
    // OCPP 1.2: exactly 3 fields (connectorId, status, errorCode).
    // Per XSD verification: info/timestamp/vendorId/vendorErrorCode do NOT exist in 1.2.
    const payload: Ocpp12StatusNotificationRequest = {
      connectorId,
      status: projectStatusForVersion(
        OCPP_1_2,
        status,
      ) as Ocpp12ChargePointStatus,
      errorCode: projectErrorCodeForVersion(
        OCPP_1_2,
        opts?.errorCode ?? "NoError",
      ) as Ocpp12ChargePointErrorCode,
    };
    return soapPayload(payload);
  },

  toMeterValuesRequest(connectorId, _transactionId, sampledValues, timestamp) {
    // OCPP 1.2: flat shape. values[] of {timestamp, value:int} (Wh implied, no transactionId).
    // Per wire-facts: Energy.Active.Import.Register sample only; pick the Wh value.
    const wattHourValue = sampledValues.find(
      (sv) => sv.measurand === "Energy.Active.Import.Register" && sv.value,
    );
    const payload: Ocpp12MeterValuesRequest = {
      connectorId,
      values: [
        {
          timestamp: timestamp.toISOString(),
          value: wattHourValue?.value ?? "0",
        },
      ],
    };
    return soapPayload(payload);
  },

  toStartTransactionRequest(transaction, connectorId) {
    // OCPP 1.2: connectorId, idTag, timestamp, meterStart (NO reservationId).
    const payload: Ocpp12StartTransactionRequest = {
      connectorId,
      idTag: transaction.tagId,
      timestamp: transaction.startTime.toISOString(),
      meterStart: transaction.meterStart,
    };
    return soapPayload(payload);
  },
};

export const OCPP16_WIRE_PROFILE: ClientWireProfile = {
  toStatusNotificationRequest(connectorId, status, opts) {
    // OCPP 1.6 SOAP: full shape with passthrough enums (no collapsing).
    // 1.6 enums are identical to 1.6J: Preparing stays Preparing, EVCommunicationError stays.
    // Field order: connectorId, status, errorCode, info?, timestamp?, vendorId?, vendorErrorCode?
    const payload: Ocpp16StatusNotificationRequest = {
      connectorId,
      status: projectStatusForVersion(
        OCPP_1_6_SOAP,
        status,
      ) as Ocpp16ChargePointStatus,
      errorCode: projectErrorCodeForVersion(
        OCPP_1_6_SOAP,
        opts?.errorCode ?? "NoError",
      ) as Ocpp16ChargePointErrorCode,
      ...(opts?.info ? { info: opts.info } : {}),
      ...(opts?.timestamp ? { timestamp: opts.timestamp.toISOString() } : {}),
      ...(opts?.vendorId ? { vendorId: opts.vendorId } : {}),
      ...(opts?.vendorErrorCode
        ? { vendorErrorCode: opts.vendorErrorCode }
        : {}),
    };
    return soapPayload(payload);
  },

  toMeterValuesRequest(connectorId, transactionId, sampledValues, timestamp) {
    // OCPP 1.6 SOAP: meterValue[] with sampledValue[] as child elements (not attributes).
    // Field order: connectorId, transactionId?, meterValue[]
    // Within meterValue: timestamp, sampledValue[]
    // Within sampledValue: value, context?, format?, measurand?, phase?, location?, unit?
    const payload: Ocpp16MeterValuesRequest = {
      connectorId,
      ...(transactionId !== undefined ? { transactionId } : {}),
      meterValue: [
        {
          timestamp: timestamp.toISOString(),
          sampledValue: sampledValues.map(toOcpp16SampledValue),
        },
      ],
    };
    return soapPayload(payload);
  },

  toStartTransactionRequest(transaction, connectorId) {
    // OCPP 1.6: connectorId, idTag, timestamp, meterStart, reservationId?
    const payload: Ocpp16StartTransactionRequest = {
      connectorId,
      idTag: transaction.tagId,
      timestamp: transaction.startTime.toISOString(),
      meterStart: transaction.meterStart,
      ...(transaction.reservationId !== undefined
        ? { reservationId: transaction.reservationId }
        : {}),
    };
    return soapPayload(payload);
  },
};
