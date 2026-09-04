import type {
  ChargePointResetType,
  ChargePoint,
} from "../../../domain/charge-point/ChargePoint";
import { Logger, LogType } from "../../../shared/Logger";
import {
  buildSoapEnvelope,
  buildSoapFaultEnvelope,
  parseSoapEnvelope,
  soapContentTypeForOperation,
  soapFaultContentType,
  type ParsedSoapEnvelope,
  type SoapOperation,
  type SoapParsedPayload,
  type SoapParsedValue,
  type SoapPayload,
} from "./soapEnvelope";
import type { SoapDialect } from "./dialect";
import { OCPP15_DIALECT } from "./dialect";
import {
  OCPP_1_6_SOAP,
  OCPP_1_5,
  OCPP_1_2,
} from "../../../domain/types/OcppVersion";
import {
  assertValidInboundRequest,
  coerceAndSchemaForOperation,
  dispatchSoapCallViaV16Registry,
  SoapRequestValidationError,
  transformResponseForOcpp12,
} from "./v16RegistryDispatch";

export interface OCPPSoapServerTarget {
  readonly cpId: string;
  readonly applyRemoteReset: (type: ChargePointResetType) => void;
  readonly isRegisteredSoapChargePoint: () => boolean;
  readonly chargePoint?: ChargePoint;
  readonly logger?: Logger;
}

export interface OCPP15SoapInboundContext {
  readonly target: OCPPSoapServerTarget;
  readonly envelope: ParsedSoapEnvelope;
}

export interface OCPP15SoapInboundResult {
  readonly payload: SoapPayload;
  readonly afterResponse?: () => void;
}

export interface OCPP15SoapInboundHandler {
  readonly handle: (
    payload: SoapParsedPayload,
    context: OCPP15SoapInboundContext,
  ) => OCPP15SoapInboundResult;
}

export type OCPP15SoapInboundRegistry = Map<
  SoapOperation,
  OCPP15SoapInboundHandler
>;

export class OCPPSoapFaultError extends Error {
  readonly status: number;
  readonly code: "Sender" | "Receiver";

  constructor(
    message: string,
    status = 400,
    code: "Sender" | "Receiver" = "Sender",
  ) {
    super(message);
    this.name = "OCPPSoapFaultError";
    this.status = status;
    this.code = code;
  }
}

export class OCPPSoapServer {
  private readonly registry: OCPP15SoapInboundRegistry;
  private readonly dialect: SoapDialect;

  constructor(
    private readonly target: OCPPSoapServerTarget,
    registry: OCPP15SoapInboundRegistry = buildOCPP15SoapInboundRegistry(),
    dialect: SoapDialect = OCPP15_DIALECT,
  ) {
    this.registry = registry;
    this.dialect = dialect;
  }

  async handleRequest(pathCpId: string, xml: string): Promise<Response> {
    let envelope: ParsedSoapEnvelope;
    try {
      envelope = parseSoapEnvelope(xml, this.dialect);
      this.assertRequestForTarget(pathCpId, envelope);

      // Dispatch order:
      // (1) Legacy inbound registry (Reset) — unchanged for all dialects
      // (2) 1.2 / 1.5 / 1.6S with v16 registry support — dispatch CS→CP
      //     through the shared handlers (filtered by each dialect's metadata)
      // (3) Else not-implemented Fault

      let responsePayload: SoapPayload;
      let afterResponse: (() => void) | undefined;

      const operationMetadata =
        this.dialect.operationMetadata[envelope.operation];
      const isV16Supported = this.dialect.version === OCPP_1_6_SOAP;
      const isV15Supported = this.dialect.version === OCPP_1_5;
      const isV12Supported = this.dialect.version === OCPP_1_2;

      // A bidirectional op (DataTransfer) arriving at the ChargePointService is
      // a CS→CP call, so it is dispatchable here even though its metadata
      // target is "cs" (issue #257).
      const isDispatchable =
        !!operationMetadata &&
        (operationMetadata.target === "cp" || operationMetadata.bidirectional);

      // #110/#257: surface the inbound call to the scenario layer
      // (csmsCallTrigger), but ONLY once we know it has a dispatch path —
      // emitting for a not-implemented op would wrongly resolve a waiting
      // trigger. Mirrors the JSON path, which notifies for calls it handles.
      const notifyIncomingCall = () =>
        this.target.chargePoint?.notifyIncomingCall(
          envelope.operation,
          envelope.payload,
        );

      // Wire lines for the CS→CP direction. `OCPPSoapHandler` logs the two
      // outbound ones ("SOAP POST" / "SOAP response"); without these, every
      // inbound SOAP exchange — a Reset or RemoteStartTransaction arriving on
      // the callback endpoint — was invisible to the log-derived observers
      // (`--trace-output`, `/metrics`) that the JSON transport feeds.
      this.target.logger?.info(
        `SOAP request ${envelope.operation}: ${xml}`,
        LogType.OCPP,
      );

      // First try legacy registry (Reset for all dialects)
      const legacyHandler = this.registry.get(envelope.operation);
      if (legacyHandler) {
        notifyIncomingCall();
        // #285: this path predates the shared dispatcher and would otherwise
        // be the one 1.6-S operation nobody checks -- the one that reboots
        // the station.
        const { coerced, schema } = coerceAndSchemaForOperation(
          envelope.operation,
          envelope.payload,
        );
        assertValidInboundRequest(
          envelope.operation,
          coerced,
          schema,
          this.dialect,
        );
        const result = legacyHandler.handle(envelope.payload, {
          target: this.target,
          envelope,
        });
        responsePayload = result.payload;
        afterResponse = result.afterResponse;
      } else if (
        (isV16Supported || isV15Supported || isV12Supported) &&
        isDispatchable &&
        this.target.chargePoint &&
        this.target.logger
      ) {
        notifyIncomingCall();
        // Dispatch through the shared v16 registry. 1.2 narrows a few enum
        // tokens afterwards; 1.5 shares 1.6's enums so needs no transform.
        try {
          responsePayload = await dispatchSoapCallViaV16Registry({
            operation: envelope.operation,
            payload: envelope.payload,
            chargePoint: this.target.chargePoint,
            logger: this.target.logger,
            dialect: this.dialect,
          });

          // Transform response for 1.2 (narrow enum mapping)
          if (isV12Supported) {
            responsePayload = transformResponseForOcpp12(
              envelope.operation,
              responsePayload,
            );
          }
        } catch (dispatchErr) {
          // #285: a request that does not satisfy its schema is the caller's
          // fault and says which element is wrong, so it is reported as
          // itself. Wrapping it in "Dispatch error for X" would bury the one
          // part of the message worth reading.
          if (dispatchErr instanceof SoapRequestValidationError) {
            throw new OCPPSoapFaultError(errorMessage(dispatchErr));
          }
          // If dispatch fails, treat as not-implemented
          throw new OCPPSoapFaultError(
            `Dispatch error for ${envelope.operation}: ${errorMessage(dispatchErr)}`,
          );
        }
      } else {
        throw new OCPPSoapFaultError(
          `${envelope.operation} is not implemented by the SOAP ChargePointService`,
        );
      }

      const responseXml = buildSoapEnvelope({
        operation: envelope.operation,
        kind: "response",
        chargeBoxIdentity: this.target.cpId,
        messageId: generateMessageId(),
        from: envelope.to,
        to: responseToAddress(envelope),
        relatesTo: envelope.messageId,
        payload: responsePayload,
        dialect: this.dialect,
        // A bidirectional op answered here is a CS→CP call, so its response
        // serializes in the ChargePointService (CP) namespace, not the CS one
        // that metadata.target would otherwise select.
        service: operationMetadata?.bidirectional ? "cp" : undefined,
      });
      this.target.logger?.info(
        `SOAP reply ${envelope.operation}: ${responseXml}`,
        LogType.OCPP,
      );
      afterResponse?.();
      return new Response(responseXml, {
        status: 200,
        headers: {
          "content-type": soapContentTypeForOperation(
            envelope.operation,
            "response",
            this.dialect,
          ),
        },
      });
    } catch (err) {
      if (err instanceof OCPPSoapFaultError) {
        return soapFaultResponse(errorMessage(err), err.status, err.code);
      }
      return soapFaultResponse(errorMessage(err), 400);
    }
  }

  private assertRequestForTarget(
    pathCpId: string,
    envelope: ParsedSoapEnvelope,
  ): void {
    if (!this.target.isRegisteredSoapChargePoint()) {
      throw new OCPPSoapFaultError(
        "SOAP ChargePointService target is not a registered SOAP charge point",
        403,
      );
    }
    if (envelope.kind !== "request") {
      throw new OCPPSoapFaultError("SOAP ChargePointService expects a request");
    }
    if (envelope.namespace !== this.dialect.namespaces.CP) {
      throw new OCPPSoapFaultError(
        `SOAP ChargePointService namespace must be ${this.dialect.namespaces.CP}`,
      );
    }
    if (!envelope.chargeBoxIdentity) {
      throw new OCPPSoapFaultError(
        "SOAP ChargePointService request is missing chargeBoxIdentity",
      );
    }
    if (
      pathCpId !== this.target.cpId ||
      envelope.chargeBoxIdentity !== this.target.cpId
    ) {
      throw new OCPPSoapFaultError(
        "SOAP chargeBoxIdentity does not match the target charge point",
      );
    }
  }
}

export function buildOCPP15SoapInboundRegistry(): OCPP15SoapInboundRegistry {
  return new Map<SoapOperation, OCPP15SoapInboundHandler>([
    [
      "Reset",
      {
        handle: (payload, context) => handleReset(payload, context),
      },
    ],
  ]);
}

export function soapFaultResponse(
  reason: string,
  status = 500,
  code: "Sender" | "Receiver" = status >= 500 ? "Receiver" : "Sender",
): Response {
  return new Response(buildSoapFaultEnvelope({ reason, code }), {
    status,
    headers: {
      "content-type": soapFaultContentType(),
    },
  });
}

function handleReset(
  payload: SoapParsedPayload,
  context: OCPP15SoapInboundContext,
): OCPP15SoapInboundResult {
  const type = resetType(payload.type);
  if (!type) {
    throw new OCPPSoapFaultError("Reset request type must be Hard or Soft");
  }

  return {
    payload: { status: "Accepted" },
    afterResponse: () => {
      queueMicrotask(() => context.target.applyRemoteReset(type));
    },
  };
}

function resetType(
  value: SoapParsedValue | undefined,
): ChargePointResetType | null {
  if (value === "Hard" || value === "Soft") return value;
  return null;
}

function responseToAddress(envelope: ParsedSoapEnvelope): string {
  if (envelope.from) return envelope.from;
  if (envelope.replyTo) return envelope.replyTo;
  return "http://www.w3.org/2005/08/addressing/anonymous";
}

function generateMessageId(): string {
  return `uuid:${crypto.randomUUID()}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
