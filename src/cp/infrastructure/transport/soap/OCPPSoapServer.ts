import type { ChargePointResetType } from "../../../domain/charge-point/ChargePoint";
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

export interface OCPPSoapServerTarget {
  readonly cpId: string;
  readonly applyRemoteReset: (type: ChargePointResetType) => void;
  readonly isRegisteredSoapChargePoint: () => boolean;
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

  handleRequest(pathCpId: string, xml: string): Response {
    let envelope: ParsedSoapEnvelope;
    try {
      envelope = parseSoapEnvelope(xml, this.dialect);
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
        dialect: this.dialect,
      });
      result.afterResponse?.();
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
