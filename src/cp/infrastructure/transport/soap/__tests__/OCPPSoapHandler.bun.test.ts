import { describe, expect, it } from "bun:test";

import { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import {
  BootNotification,
  OCPPStatus,
} from "../../../../domain/types/OcppTypes";
import {
  OCPP15_SOAP_NAMESPACES,
  parseSoapEnvelope,
  SOAP_OPERATION_METADATA,
  soapContentTypeForOperation,
  WSA_ANONYMOUS_ADDRESS,
  type ParsedSoapEnvelope,
  type SoapOperation,
  type SoapPayload,
  type SoapPayloadValue,
} from "../soapEnvelope";

interface ReceivedSoapRequest {
  readonly body: string;
  readonly contentType: string;
  readonly parsed: ParsedSoapEnvelope;
}

function responsePayloadFor(operation: SoapOperation): SoapPayload {
  switch (operation) {
    case "BootNotification":
      return {
        status: "Accepted",
        currentTime: "2026-06-30T00:00:00Z",
        heartbeatInterval: 0,
      };
    case "Heartbeat":
      return { currentTime: "2026-06-30T00:00:05Z" };
    case "Authorize":
      return { idTagInfo: { status: "Accepted" } };
    case "StartTransaction":
      return { transactionId: 101, idTagInfo: { status: "Accepted" } };
    case "StopTransaction":
      return {};
    case "MeterValues":
    case "StatusNotification":
      return {};
    default:
      throw new Error(`Unexpected SOAP operation in fake CSMS: ${operation}`);
  }
}

function xmlText(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

function payloadValueXml(name: string, value: SoapPayloadValue): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) {
    return value.map((item) => payloadValueXml(name, item)).join("");
  }
  if (value === null) return `<${name}/>`;
  if (value instanceof Date) {
    return `<${name}>${xmlText(value.toISOString())}</${name}>`;
  }
  if (typeof value === "object") {
    return `<${name}>${payloadXml(value as SoapPayload)}</${name}>`;
  }
  return `<${name}>${xmlText(String(value))}</${name}>`;
}

function payloadXml(payload: SoapPayload): string {
  return Object.entries(payload)
    .map(([name, value]) => payloadValueXml(name, value))
    .join("");
}

function buildSteVeStyleResponseEnvelope(
  operation: SoapOperation,
  messageId: string,
  relatesTo: string,
  payload: SoapPayload,
): string {
  const metadata = SOAP_OPERATION_METADATA[operation];
  const action = `${metadata.action}Response`;
  return [
    `<soap:Envelope xmlns:soap="${OCPP15_SOAP_NAMESPACES.SOAP12}">`,
    "<soap:Header>",
    `<Action xmlns="${OCPP15_SOAP_NAMESPACES.WSA}">${xmlText(action)}</Action>`,
    `<MessageID xmlns="${OCPP15_SOAP_NAMESPACES.WSA}">${xmlText(messageId)}</MessageID>`,
    `<To xmlns="${OCPP15_SOAP_NAMESPACES.WSA}">${xmlText(WSA_ANONYMOUS_ADDRESS)}</To>`,
    `<RelatesTo xmlns="${OCPP15_SOAP_NAMESPACES.WSA}">${xmlText(relatesTo)}</RelatesTo>`,
    "</soap:Header>",
    "<soap:Body>",
    `<${metadata.responseWrapper} xmlns="${metadata.namespace}">${payloadXml(payload)}</${metadata.responseWrapper}>`,
    "</soap:Body>",
    "</soap:Envelope>",
  ].join("");
}

function startFakeCentralSystemService() {
  const received: ReceivedSoapRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      const parsed = parseSoapEnvelope(body);
      received.push({
        body,
        contentType: req.headers.get("content-type") ?? "",
        parsed,
      });

      const responseXml = buildSteVeStyleResponseEnvelope(
        parsed.operation,
        `uuid:conf-${received.length}`,
        parsed.messageId,
        responsePayloadFor(parsed.operation),
      );
      return new Response(responseXml, {
        headers: {
          "Content-Type": soapContentTypeForOperation(
            parsed.operation,
            "response",
          ),
        },
      });
    },
  });

  return {
    url: server.url.toString(),
    received,
    stop: () => server.stop(true),
  };
}

async function waitForOperationCount(
  received: readonly ReceivedSoapRequest[],
  operation: SoapOperation,
  count: number,
): Promise<ReceivedSoapRequest> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const matches = received.filter(
      (entry) => entry.parsed.operation === operation,
    );
    if (matches.length >= count) return matches[count - 1];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${operation} #${count}; saw ${received
      .map((entry) => entry.parsed.operation)
      .join(", ")}`,
  );
}

async function waitUntil(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for assertion");
}

function expectSoapRequest(
  request: ReceivedSoapRequest,
  operation: SoapOperation,
  cpId: string,
  callbackUrl: string,
  centralSystemUrl: string,
): void {
  expect(request.contentType).toBe(soapContentTypeForOperation(operation));
  expect(request.parsed).toMatchObject({
    operation,
    kind: "request",
    action: `/${operation}`,
    chargeBoxIdentity: cpId,
    from: callbackUrl,
    replyTo: WSA_ANONYMOUS_ADDRESS,
    to: centralSystemUrl,
  });
  expect(request.body).toContain("<cs:chargeBoxIdentity>" + cpId);
}

describe("OCPPSoapHandler CP-to-CSMS client", () => {
  it("posts OCPP 1.5 SOAP Boot, Heartbeat, Status, transaction, and MeterValues requests", async () => {
    const csms = startFakeCentralSystemService();
    const cpId = "CP-SOAP";
    const callbackUrl =
      "http://127.0.0.1:9700/ocpp/soap/CP-SOAP/ChargePointService";
    const bootNotification: BootNotification = {
      chargePointVendor: "TestVendor",
      chargePointModel: "TestModel",
      chargePointSerialNumber: "Point-001",
      chargeBoxSerialNumber: "Box-001",
      firmwareVersion: "1.2.3",
      iccid: "",
      imsi: "",
      meterType: "",
      meterSerialNumber: "Meter-001",
    };
    const cp = new ChargePoint(
      cpId,
      bootNotification,
      1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      "OCPP-1.5",
      {
        centralSystemUrl: csms.url,
        soapCallbackUrl: callbackUrl,
        soapPath: "/ocpp/soap",
      },
    );

    try {
      cp.connect();

      const boot = await waitForOperationCount(
        csms.received,
        "BootNotification",
        1,
      );
      expectSoapRequest(boot, "BootNotification", cpId, callbackUrl, csms.url);
      expect(boot.parsed.payload).toMatchObject({
        chargePointVendor: "TestVendor",
        chargePointModel: "TestModel",
      });

      await waitForOperationCount(csms.received, "StatusNotification", 2);
      await waitUntil(() => cp.status === OCPPStatus.Available);

      cp.sendHeartbeat();
      const heartbeat = await waitForOperationCount(
        csms.received,
        "Heartbeat",
        1,
      );
      expectSoapRequest(heartbeat, "Heartbeat", cpId, callbackUrl, csms.url);

      cp.authorize("TAG-DEMO");
      const authorize = await waitForOperationCount(
        csms.received,
        "Authorize",
        1,
      );
      expectSoapRequest(authorize, "Authorize", cpId, callbackUrl, csms.url);
      expect(authorize.parsed.payload).toMatchObject({ idTag: "TAG-DEMO" });

      cp.updateConnectorStatus(1, OCPPStatus.Preparing);
      const status = await waitForOperationCount(
        csms.received,
        "StatusNotification",
        3,
      );
      expectSoapRequest(
        status,
        "StatusNotification",
        cpId,
        callbackUrl,
        csms.url,
      );
      expect(status.parsed.payload).toMatchObject({
        connectorId: "1",
        status: "Preparing",
        errorCode: "NoError",
      });

      cp.startTransaction("TAG-DEMO", 1);
      const start = await waitForOperationCount(
        csms.received,
        "StartTransaction",
        1,
      );
      expectSoapRequest(start, "StartTransaction", cpId, callbackUrl, csms.url);
      expect(start.parsed.payload).toMatchObject({
        connectorId: "1",
        idTag: "TAG-DEMO",
        meterStart: "0",
      });
      await waitUntil(() => cp.getConnector(1)?.transaction?.id === 101);

      cp.setMeterValue(1, 1234);
      cp.sendMeterValue(1);
      const meterValues = await waitForOperationCount(
        csms.received,
        "MeterValues",
        1,
      );
      expectSoapRequest(
        meterValues,
        "MeterValues",
        cpId,
        callbackUrl,
        csms.url,
      );
      expect(meterValues.parsed.payload).toMatchObject({
        connectorId: "1",
        transactionId: "101",
      });

      cp.stopTransaction(1, "Remote");
      const stop = await waitForOperationCount(
        csms.received,
        "StopTransaction",
        1,
      );
      expectSoapRequest(stop, "StopTransaction", cpId, callbackUrl, csms.url);
      expect(stop.parsed.payload).toMatchObject({
        transactionId: "101",
        idTag: "TAG-DEMO",
      });
      expect(stop.parsed.payload).not.toHaveProperty("reason");
    } finally {
      cp.disconnect();
      csms.stop();
    }
  });
});
