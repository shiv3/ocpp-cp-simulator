import type { ChargePointResetType } from "../../../domain/charge-point/ChargePoint";
import {
  buildSoapEnvelope,
  buildSoapFaultEnvelope,
  OCPP15_SOAP_NAMESPACES,
  parseSoapEnvelope,
  soapContentTypeForOperation,
  soapFaultContentType,
  type ParsedSoapEnvelope,
  type SoapOperation,
  type SoapParsedPayload,
  type SoapParsedValue,
  type SoapPayload,
} from "./soapEnvelope";

export interface OCPPSoapServerTarget {
  readonly cpId: string;
  readonly applyRemoteReset: (type: ChargePointResetType) => void;
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
  constructor(message: string) {
    super(message);
    this.name = "OCPPSoapFaultError";
  }
}

export class OCPPSoapServer {
  private readonly registry: OCPP15SoapInboundRegistry;

  constructor(
    private readonly target: OCPPSoapServerTarget,
    registry: OCPP15SoapInboundRegistry = buildOCPP15SoapInboundRegistry(),
  ) {
    this.registry = registry;
  }

  handleRequest(pathCpId: string, xml: string): Response {
    let envelope: ParsedSoapEnvelope;
    try {
      envelope = parseSoapEnvelope(xml);
      this.assertRequestForTarget(pathCpId, envelope);

      const handler = this.registry.get(envelope.operation);
      if (!handler) {
        throw new OCPPSoapFaultError(
          `${envelope.operation} is not implemented by the SOAP ChargePointService`,
        );
      }

      const result = handler.handle(envelope.payload, {
        target: this.target,
        envelope,
      });
      const responseXml = buildSoapEnvelope({
        operation: envelope.operation,
        kind: "response",
        chargeBoxIdentity: this.target.cpId,
        messageId: generateMessageId(),
        from: envelope.to,
        to: responseToAddress(envelope),
        relatesTo: envelope.messageId,
        payload: result.payload,
      });
      result.afterResponse?.();
      return new Response(responseXml, {
        status: 200,
        headers: {
          "content-type": soapContentTypeForOperation(
            envelope.operation,
            "response",
          ),
        },
      });
    } catch (err) {
      return soapFaultResponse(errorMessage(err));
    }
  }

  private assertRequestForTarget(
    pathCpId: string,
    envelope: ParsedSoapEnvelope,
  ): void {
    if (envelope.kind !== "request") {
      throw new OCPPSoapFaultError("SOAP ChargePointService expects a request");
    }
    if (envelope.namespace !== OCPP15_SOAP_NAMESPACES.CP) {
      throw new OCPPSoapFaultError(
        `SOAP ChargePointService namespace must be ${OCPP15_SOAP_NAMESPACES.CP}`,
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

export function soapFaultResponse(reason: string, status = 500): Response {
  return new Response(buildSoapFaultEnvelope({ reason }), {
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
