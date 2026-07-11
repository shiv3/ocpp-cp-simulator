import type {
  ChargePointResetType,
  ChargePoint,
} from "../../../domain/charge-point/ChargePoint";
import { Logger } from "../../../shared/Logger";
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
import { OCPP_1_6_SOAP, OCPP_1_2 } from "../../../domain/types/OcppVersion";
import {
  dispatchSoapCallViaV16Registry,
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
      // (2) If 1.6S or 1.2 with v16 registry support — dispatch CS→CP through handlers
      // (3) Else not-implemented Fault

      let responsePayload: SoapPayload;
      let afterResponse: (() => void) | undefined;

      const operationMetadata =
        this.dialect.operationMetadata[envelope.operation];
      const isV16Supported = this.dialect.version === OCPP_1_6_SOAP;
      const isV12Supported = this.dialect.version === OCPP_1_2;

      // First try legacy registry (Reset for all dialects)
      const legacyHandler = this.registry.get(envelope.operation);
      if (legacyHandler) {
        const result = legacyHandler.handle(envelope.payload, {
          target: this.target,
          envelope,
        });
        responsePayload = result.payload;
        afterResponse = result.afterResponse;
      } else if (
        (isV16Supported || isV12Supported) &&
        operationMetadata &&
        operationMetadata.target === "cp" &&
        this.target.chargePoint &&
        this.target.logger
      ) {
        // Dispatch through v16 registry for full 1.6S or filtered 1.2
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
      });
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
