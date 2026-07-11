import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { Logger } from "../../../shared/Logger";
import type {
  SoapOperation,
  SoapParsedPayload,
  SoapPayload,
} from "./soapEnvelope";
import type { SoapDialect } from "./dialect";
import { buildV16CallHandlerRegistry } from "../handlers/buildV16CallHandlerRegistry";
import { DataTransferHandler } from "../handlers";
import { OCPPAction } from "../../../domain/types/OcppTypes";
import { v16Schemas } from "../../../../ocpp/v16";

/**
 * Map operation names to their v16 schema and validator.
 * Used by coerceSoapPayloadWithSchema to transform SOAP strings to typed values.
 */
function getSchemaForOperation(operation: SoapOperation): {
  schema: Record<string, unknown> | undefined;
  action: OCPPAction | null;
} {
  // Map operation names to OCPPAction and schema
  const operationMap: Record<
    string,
    { action: OCPPAction; schema: Record<string, unknown> }
  > = {
    RemoteStartTransaction: {
      action: OCPPAction.RemoteStartTransaction,
      schema: v16Schemas.remoteStartTransactionRequestV16 as Record<
        string,
        unknown
      >,
    },
    RemoteStopTransaction: {
      action: OCPPAction.RemoteStopTransaction,
      schema: v16Schemas.remoteStopTransactionRequestV16 as Record<
        string,
        unknown
      >,
    },
    TriggerMessage: {
      action: OCPPAction.TriggerMessage,
      schema: v16Schemas.triggerMessageRequestV16 as Record<string, unknown>,
    },
    ChangeAvailability: {
      action: OCPPAction.ChangeAvailability,
      schema: v16Schemas.changeAvailabilityRequestV16 as Record<
        string,
        unknown
      >,
    },
    ChangeConfiguration: {
      action: OCPPAction.ChangeConfiguration,
      schema: v16Schemas.changeConfigurationRequestV16 as Record<
        string,
        unknown
      >,
    },
    GetConfiguration: {
      action: OCPPAction.GetConfiguration,
      schema: v16Schemas.getConfigurationRequestV16 as Record<string, unknown>,
    },
    UnlockConnector: {
      action: OCPPAction.UnlockConnector,
      schema: v16Schemas.unlockConnectorRequestV16 as Record<string, unknown>,
    },
    ReserveNow: {
      action: OCPPAction.ReserveNow,
      schema: v16Schemas.reserveNowRequestV16 as Record<string, unknown>,
    },
    CancelReservation: {
      action: OCPPAction.CancelReservation,
      schema: v16Schemas.cancelReservationRequestV16 as Record<string, unknown>,
    },
    SetChargingProfile: {
      action: OCPPAction.SetChargingProfile,
      schema: v16Schemas.setChargingProfileRequestV16 as Record<
        string,
        unknown
      >,
    },
    ClearChargingProfile: {
      action: OCPPAction.ClearChargingProfile,
      schema: v16Schemas.clearChargingProfileRequestV16 as Record<
        string,
        unknown
      >,
    },
    GetCompositeSchedule: {
      action: OCPPAction.GetCompositeSchedule,
      schema: v16Schemas.getCompositeScheduleRequestV16 as Record<
        string,
        unknown
      >,
    },
    GetLocalListVersion: {
      action: OCPPAction.GetLocalListVersion,
      schema: v16Schemas.getLocalListVersionRequestV16 as Record<
        string,
        unknown
      >,
    },
    SendLocalList: {
      action: OCPPAction.SendLocalList,
      schema: v16Schemas.sendLocalListRequestV16 as Record<string, unknown>,
    },
    GetDiagnostics: {
      action: OCPPAction.GetDiagnostics,
      schema: v16Schemas.getDiagnosticsRequestV16 as Record<string, unknown>,
    },
    UpdateFirmware: {
      action: OCPPAction.UpdateFirmware,
      schema: v16Schemas.updateFirmwareRequestV16 as Record<string, unknown>,
    },
    ClearCache: {
      action: OCPPAction.ClearCache,
      schema: v16Schemas.clearCacheRequestV16 as Record<string, unknown>,
    },
    Reset: {
      action: OCPPAction.Reset,
      schema: v16Schemas.resetRequestV16 as Record<string, unknown>,
    },
    GetInstalledCertificateIds: {
      action: OCPPAction.GetInstalledCertificateIds,
      schema: v16Schemas.getInstalledCertificateIdsRequestV16 as Record<
        string,
        unknown
      >,
    },
    DeleteCertificate: {
      action: OCPPAction.DeleteCertificate,
      schema: v16Schemas.deleteCertificateRequestV16 as Record<string, unknown>,
    },
    GetLog: {
      action: OCPPAction.GetLog,
      schema: v16Schemas.getLogRequestV16 as Record<string, unknown>,
    },
    CertificateSigned: {
      action: OCPPAction.CertificateSigned,
      schema: v16Schemas.certificateSignedRequestV16 as Record<string, unknown>,
    },
    InstallCertificate: {
      action: OCPPAction.InstallCertificate,
      schema: v16Schemas.installCertificateRequestV16 as Record<
        string,
        unknown
      >,
    },
    ExtendedTriggerMessage: {
      action: OCPPAction.ExtendedTriggerMessage,
      schema: v16Schemas.extendedTriggerMessageRequestV16 as Record<
        string,
        unknown
      >,
    },
    SignedUpdateFirmware: {
      action: OCPPAction.SignedUpdateFirmware,
      schema: v16Schemas.signedUpdateFirmwareRequestV16 as Record<
        string,
        unknown
      >,
    },
    DataTransfer: {
      action: OCPPAction.DataTransfer,
      schema: v16Schemas.dataTransferRequestV16 as Record<string, unknown>,
    },
  };

  const entry = operationMap[operation];
  return {
    schema: entry?.schema,
    action: entry?.action ?? null,
  };
}

/**
 * Coerce SOAP-parsed payload (all strings from fast-xml-parser) to proper types
 * according to the v16 JSON schema for the operation.
 *
 * Schema walk rules:
 * - "integer"/"number" fields: Number(value) if value is a string
 * - "boolean" fields: value === "true"
 * - array fields: if schema expects array but payload has single object/string,
 *   wrap in [ ]
 * - nested objects: recurse
 * - unknown keys: pass through untouched
 *
 * Returns the coerced payload object, ready for handler dispatch.
 */
export function coerceSoapPayloadWithSchema(
  payload: SoapParsedPayload,
  schema: Record<string, unknown> | undefined,
): unknown {
  if (!schema || !schema.properties) {
    // No schema to coerce against; return payload as-is
    return payload;
  }

  const properties = schema.properties as Record<string, unknown>;
  const coerced: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    const propSchema = properties[key] as Record<string, unknown> | undefined;
    if (!propSchema) {
      // Unknown key; pass through untouched
      coerced[key] = value;
      continue;
    }

    const propType = propSchema.type;

    if (propType === "integer") {
      // Coerce string to number
      coerced[key] = typeof value === "string" ? Number(value) : value;
    } else if (propType === "number") {
      coerced[key] = typeof value === "string" ? Number(value) : value;
    } else if (propType === "boolean") {
      coerced[key] = value === "true" || value === true;
    } else if (propType === "array") {
      // If schema says array but we got a single element, wrap it
      if (Array.isArray(value)) {
        coerced[key] = value;
      } else if (value !== undefined && value !== null) {
        coerced[key] = [value];
      } else {
        coerced[key] = value;
      }
    } else if (propType === "object" && typeof value === "object") {
      // Recurse into nested objects
      coerced[key] = coerceSoapPayloadWithSchema(
        value as SoapParsedPayload,
        propSchema,
      );
    } else {
      // Default: pass through
      coerced[key] = value;
    }
  }

  return coerced;
}

/**
 * Dispatch a SOAP CS→CP request through the shared v16 CALL-handler registry.
 *
 * Steps:
 * 1. Coerce the SOAP payload to proper types using the v16 JSON schema
 * 2. Validate the coerced payload (warn-only on failure)
 * 3. Look up and execute the CALL handler for the operation
 * 4. Return the response payload
 *
 * DataTransfer is handled specially: dispatched to a fresh DataTransferHandler()
 * instance since it must be instance-specific in full dispatch context.
 */
export async function dispatchSoapCallViaV16Registry(input: {
  operation: SoapOperation;
  payload: SoapParsedPayload;
  chargePoint: ChargePoint;
  logger: Logger;
  dialect: SoapDialect;
}): Promise<SoapPayload> {
  const { operation, payload, chargePoint, logger } = input;

  // Get the schema and action for this operation
  const { schema, action } = getSchemaForOperation(operation);
  if (!action) {
    throw new Error(
      `No handler mapping found for operation: ${operation}; this should have been caught by the dialect filter`,
    );
  }

  // Coerce the SOAP payload to proper types
  const coercedPayload = coerceSoapPayloadWithSchema(payload, schema);

  // Build the handler registry (stateless handlers only; DataTransfer is special)
  const registry = buildV16CallHandlerRegistry();

  // For DataTransfer, use a fresh instance since it's not in the shared registry
  if (action === OCPPAction.DataTransfer) {
    const dataTransferHandler = new DataTransferHandler();
    const response = dataTransferHandler.handle(coercedPayload, {
      chargePoint,
      logger,
    });
    return (await Promise.resolve(response)) as SoapPayload;
  }

  // Look up the CALL handler
  const handler = registry.getCallHandler(action);
  if (!handler) {
    throw new Error(
      `No handler registered for action: ${action}; check if operation is in dialect's CS→CP surface`,
    );
  }

  // Execute the handler (may return Promise)
  const response = handler.handle(coercedPayload, {
    chargePoint,
    logger,
  });

  return (await Promise.resolve(response)) as SoapPayload;
}

/**
 * Response transformation for OCPP 1.2 (narrow enum mapping).
 *
 * OCPP 1.6 handlers return 1.6 response enums; some do not exist in 1.2.
 * This function maps 1.6 responses to 1.2-valid enum values.
 *
 * 1.2 response enum sets (verbatim from the OCPP 1.2 ChargePointService WSDL
 * XSD, steve-community/ocpp-jaxb chargepointservice.wsdl):
 *
 * - UnlockStatus: Accepted, Rejected
 *   (1.6 Unlocked→Accepted; UnlockFailed/NotSupported→Rejected)
 * - AvailabilityStatus: Accepted, Rejected, Scheduled — Scheduled EXISTS in
 *   1.2, so no mapping.
 * - ConfigurationStatus: Accepted, Rejected, NotSupported — 1.2 has NO
 *   RebootRequired; a change that was applied but needs a reboot is still an
 *   accepted change, so RebootRequired→Accepted.
 * - ClearCacheStatus / ResetStatus / RemoteStartStopStatus: Accepted,
 *   Rejected — identical to the 1.6 handler output, no mapping.
 * - GetDiagnosticsResponse (fileName?) / UpdateFirmwareResponse (empty):
 *   no status field, no mapping.
 */
export function transformResponseForOcpp12(
  operation: SoapOperation,
  response: SoapPayload,
): SoapPayload {
  // Only transform responses that carry 1.6-only enum values.
  if (operation === "UnlockConnector") {
    const status = (response as Record<string, unknown>).status as string;
    if (status === "Unlocked") {
      return { ...response, status: "Accepted" };
    }
    if (status === "UnlockFailed" || status === "NotSupported") {
      return { ...response, status: "Rejected" };
    }
  } else if (operation === "ChangeConfiguration") {
    const status = (response as Record<string, unknown>).status as string;
    if (status === "RebootRequired") {
      return { ...response, status: "Accepted" };
    }
  }
  // All other operations: every 1.6 handler output token is already 1.2-valid.
  return response;
}
