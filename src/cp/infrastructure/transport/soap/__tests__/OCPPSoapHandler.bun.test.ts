import { describe, expect, it } from "bun:test";

import { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import {
  BootNotification,
  OCPPStatus,
} from "../../../../domain/types/OcppTypes";
import {
  buildSoapFaultEnvelope,
  OCPP15_SOAP_NAMESPACES,
  parseSoapEnvelope,
  SOAP_OPERATION_METADATA,
  SoapFaultError,
  soapContentTypeForOperation,
  WSA_ANONYMOUS_ADDRESS,
  type ParsedSoapEnvelope,
  type SoapOperation,
  type SoapPayload,
  type SoapPayloadValue,
} from "../soapEnvelope";
import { OCPPSoapHandler } from "../OCPPSoapHandler";
import { Logger } from "../../../../shared/Logger";

interface ReceivedSoapRequest {
  readonly body: string;
  readonly contentType: string;
  readonly parsed: ParsedSoapEnvelope;
}

const FETCH_LOCK_KEY = Symbol.for("ocpp-cp-simulator.test.fetchLock");

async function withGlobalFetch<T>(run: () => Promise<T>): Promise<T> {
  const globals = globalThis as typeof globalThis & {
    [FETCH_LOCK_KEY]?: Promise<void>;
  };
  const previous = globals[FETCH_LOCK_KEY] ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => current);
  globals[FETCH_LOCK_KEY] = chain;
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (globals[FETCH_LOCK_KEY] === chain) {
      globals[FETCH_LOCK_KEY] = Promise.resolve();
    }
  }
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
  return startFetchBackedCentralSystemService();
}

function startFirstResponseDelayedCentralSystemService(delayMs: number) {
  return startFetchBackedCentralSystemService(delayMs);
}

function startFetchBackedCentralSystemService(firstDelayMs = 0) {
  const received: ReceivedSoapRequest[] = [];
  const originalFetch = globalThis.fetch;
  const url = "http://csms.example/CentralSystemService";
  globalThis.fetch = (async (_input, init) => {
    const body = String(init?.body ?? "");
    const parsed = parseSoapEnvelope(body);
    received.push({
      body,
      contentType: headerValue(init?.headers, "content-type"),
      parsed,
    });
    if (received.length === 1 && firstDelayMs > 0) {
      await delayWithAbort(firstDelayMs, init?.signal ?? null);
    }

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
  }) as typeof fetch;

  return {
    url,
    received,
    stop: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function headerValue(headers: HeadersInit | undefined, name: string): string {
  if (!headers) return "";
  if (headers instanceof Headers) return headers.get(name) ?? "";
  const lowerName = name.toLowerCase();
  if (Array.isArray(headers)) {
    const entry = headers.find(([key]) => key.toLowerCase() === lowerName);
    return entry?.[1] ?? "";
  }
  return (
    Object.entries(headers).find(
      ([key]) => key.toLowerCase() === lowerName,
    )?.[1] ?? ""
  );
}

function delayWithAbort(
  delayMs: number,
  signal: AbortSignal | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): DOMException {
  return new DOMException("This operation was aborted", "AbortError");
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

function bootNotification(): BootNotification {
  return {
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
}

function createSoapChargePoint(
  cpId: string,
  centralSystemUrl: string,
  callbackUrl: string,
  requestTimeoutMs?: number,
): ChargePoint {
  const cp = new ChargePoint(
    cpId,
    bootNotification(),
    1,
    centralSystemUrl,
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.5",
    {
      centralSystemUrl,
      soapCallbackUrl: callbackUrl,
      soapPath: "/ocpp/soap",
      soapRequestTimeoutMs: requestTimeoutMs,
    },
  );
  cp.events.on("error", () => undefined);
  return cp;
}

type SoapPostForTest = {
  postSoap(
    operation: SoapOperation,
    payload: SoapPayload,
  ): Promise<ParsedSoapEnvelope>;
};

function soapPostForTest(handler: OCPPSoapHandler): SoapPostForTest {
  return handler as unknown as SoapPostForTest;
}

function withFakeFaultFetch(status: number, reason: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(buildSoapFaultEnvelope({ reason, code: "Receiver" }), {
      status,
      headers: { "content-type": "application/soap+xml" },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe("OCPPSoapHandler CP-to-CSMS client", () => {
  it("posts OCPP 1.5 SOAP Boot, Heartbeat, Status, transaction, and MeterValues requests", async () => {
    await withGlobalFetch(async () => {
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
      cp.events.on("error", () => undefined);

      try {
        cp.connect();

        const boot = await waitForOperationCount(
          csms.received,
          "BootNotification",
          1,
        );
        expectSoapRequest(
          boot,
          "BootNotification",
          cpId,
          callbackUrl,
          csms.url,
        );
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
        expectSoapRequest(
          start,
          "StartTransaction",
          cpId,
          callbackUrl,
          csms.url,
        );
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

  it("times out a delayed CSMS request and continues the serialized request chain", async () => {
    await withGlobalFetch(async () => {
      const csms = startFirstResponseDelayedCentralSystemService(100);
      const cpId = "CP-SOAP-TIMEOUT";
      const callbackUrl =
        "http://127.0.0.1:9700/ocpp/soap/CP-SOAP-TIMEOUT/ChargePointService";
      const cp = createSoapChargePoint(cpId, csms.url, callbackUrl, 25);
      const logs: string[] = [];
      cp.loggingCallback = (entry) => logs.push(entry.message);

      try {
        cp.connect();
        await waitForOperationCount(csms.received, "BootNotification", 1);
        await waitUntil(() =>
          logs.some(
            (message) =>
              message.includes("SOAP BootNotification failed") &&
              message.includes("timed out after 25ms"),
          ),
        );

        cp.boot();
        const recoveredBoot = await waitForOperationCount(
          csms.received,
          "BootNotification",
          2,
        );
        expectSoapRequest(
          recoveredBoot,
          "BootNotification",
          cpId,
          callbackUrl,
          csms.url,
        );
        await waitUntil(() => cp.status === OCPPStatus.Available);
      } finally {
        cp.disconnect();
        csms.stop();
      }
    });
  });

  it("surfaces a SOAP Fault response with HTTP 200 as a typed error", async () => {
    await withGlobalFetch(async () => {
      const centralSystemUrl = "http://csms.example/CentralSystemService";
      const callbackUrl =
        "http://127.0.0.1:9700/ocpp/soap/CP-FAULT-200/ChargePointService";
      const cp = createSoapChargePoint(
        "CP-FAULT-200",
        centralSystemUrl,
        callbackUrl,
      );
      const handler = new OCPPSoapHandler(cp, new Logger(), {
        centralSystemUrl,
        soapCallbackUrl: callbackUrl,
        requestTimeoutMs: 100,
      });
      const restoreFetch = withFakeFaultFetch(
        200,
        "Accepted transport, SOAP fault",
      );

      try {
        let error: unknown;
        try {
          await soapPostForTest(handler).postSoap("Heartbeat", {});
        } catch (err) {
          error = err;
        }
        expect(error).toBeInstanceOf(SoapFaultError);
        expect((error as SoapFaultError).httpStatus).toBe(200);
        expect((error as SoapFaultError).fault).toMatchObject({
          code: "s:Receiver",
          reason: "Accepted transport, SOAP fault",
        });
      } finally {
        restoreFetch();
      }
    });
  });

  it("surfaces a SOAP Fault response with non-200 HTTP as a typed error", async () => {
    await withGlobalFetch(async () => {
      const centralSystemUrl = "http://csms.example/CentralSystemService";
      const callbackUrl =
        "http://127.0.0.1:9700/ocpp/soap/CP-FAULT-500/ChargePointService";
      const cp = createSoapChargePoint(
        "CP-FAULT-500",
        centralSystemUrl,
        callbackUrl,
      );
      const handler = new OCPPSoapHandler(cp, new Logger(), {
        centralSystemUrl,
        soapCallbackUrl: callbackUrl,
        requestTimeoutMs: 100,
      });
      const restoreFetch = withFakeFaultFetch(500, "CSMS rejected request");

      try {
        let error: unknown;
        try {
          await soapPostForTest(handler).postSoap("Heartbeat", {});
        } catch (err) {
          error = err;
        }
        expect(error).toBeInstanceOf(SoapFaultError);
        expect((error as SoapFaultError).httpStatus).toBe(500);
        expect((error as SoapFaultError).fault).toMatchObject({
          code: "s:Receiver",
          reason: "CSMS rejected request",
        });
      } finally {
        restoreFetch();
      }
    });
  });
});
