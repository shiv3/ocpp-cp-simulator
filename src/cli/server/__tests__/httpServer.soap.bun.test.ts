import { describe, expect, it } from "bun:test";

import {
  buildSoapEnvelope,
  parseSoapEnvelope,
} from "../../../cp/infrastructure/transport/soap";
import type {
  ParsedSoapEnvelope,
  SoapOperation,
  SoapPayload,
} from "../../../cp/infrastructure/transport/soap";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createHttpHandlers } from "../httpServer";
import { createLifecycle } from "../lifecycle";
import type { CLIChargePointService } from "../../service";

type FetchServer = Parameters<
  ReturnType<typeof createHttpHandlers>["fetch"]
>[1];

const stubServer = null as unknown as FetchServer;
const cpId = "CP";
const callbackUrl = "http://127.0.0.1:9700/ocpp/soap/CP/ChargePointService";
const centralSystemUrl = "http://csms.example/CentralSystemService";

describe("httpServer OCPP 1.5 SOAP ChargePointService", () => {
  it("accepts Reset for a registered CP, relates the response, and applies reset", async () => {
    const registry = createRegistry();
    const handlers = createHandlers(registry);
    const service = registry.create(soapCpInit(cpId), { seedDefault: false });
    const soapPosts: ParsedSoapEnvelope[] = [];
    const restoreFetch = installFakeCentralSystemFetch(soapPosts);

    try {
      const resetApplied = waitForServiceEvent(service, "connected");
      const res = await postSoap(
        handlers,
        "/ocpp/soap/CP/ChargePointService",
        resetEnvelope("CP", "uuid:reset-1"),
      );
      const body = await res.text();
      const parsed = parseSoapEnvelope(body);

      expect(res.status).toBe(200);
      expect(parsed).toMatchObject({
        operation: "Reset",
        kind: "response",
        action: "/ResetResponse",
        relatesTo: "uuid:reset-1",
        chargeBoxIdentity: "CP",
        payload: { status: "Accepted" },
      });

      await resetApplied;
      await waitUntil(() =>
        soapPosts.some((post) => post.operation === "BootNotification"),
      );
      await waitUntil(
        () =>
          soapPosts.filter((post) => post.operation === "StatusNotification")
            .length >= 2,
      );
    } finally {
      registry.shutdownAll();
      restoreFetch();
    }
  });

  it("returns a SOAP Fault for identity mismatch or unregistered cpId", async () => {
    const registry = createRegistry();
    const handlers = createHandlers(registry);
    registry.create(soapCpInit(cpId), { seedDefault: false });

    try {
      const mismatch = await postSoap(
        handlers,
        "/ocpp/soap/CP/ChargePointService",
        resetEnvelope("OTHER", "uuid:reset-mismatch"),
      );
      const mismatchBody = await mismatch.text();
      expect(mismatch.status).not.toBe(200);
      expect(mismatchBody).toContain("<s:Fault>");
      expect(mismatchBody).toContain("chargeBoxIdentity");

      const unknown = await postSoap(
        handlers,
        "/ocpp/soap/MISSING/ChargePointService",
        resetEnvelope("MISSING", "uuid:reset-unknown"),
      );
      const unknownBody = await unknown.text();
      expect(unknown.status).not.toBe(200);
      expect(unknownBody).toContain("<s:Fault>");
      expect(unknownBody).toContain("Unknown charge point");
    } finally {
      registry.shutdownAll();
    }
  });

  it("rejects DOCTYPE-bearing SOAP bodies with a SOAP Fault", async () => {
    const registry = createRegistry();
    const handlers = createHandlers(registry);
    registry.create(soapCpInit(cpId), { seedDefault: false });

    try {
      const res = await postSoap(
        handlers,
        "/ocpp/soap/CP/ChargePointService",
        `<!DOCTYPE s:Envelope [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${resetEnvelope(
          "CP",
          "uuid:reset-xxe",
        )}`,
      );
      const body = await res.text();
      expect(res.status).not.toBe(200);
      expect(body).toContain("<s:Fault>");
      expect(body).toContain("DOCTYPE or ENTITY");
    } finally {
      registry.shutdownAll();
    }
  });
});

function createRegistry(): CPRegistry {
  return new CPRegistry(new EventBus(), null);
}

function createHandlers(
  registry: CPRegistry,
): ReturnType<typeof createHttpHandlers> {
  return createHttpHandlers({
    registry,
    bus: new EventBus(),
    lifecycle: createLifecycle({ pidPath: null, registry }),
    database: null,
    healthPath: "/v1/healthz",
    cors: { kind: "any" },
  });
}

function soapCpInit(id: string) {
  return {
    cpId: id,
    wsUrl: centralSystemUrl,
    centralSystemUrl,
    connectors: 1,
    vendor: "TestVendor",
    model: "TestModel",
    basicAuth: null,
    ocppVersion: "OCPP-1.5",
    soapCallbackUrl: callbackUrl.replace("/CP/", `/${id}/`),
    soapPath: "/ocpp/soap",
  };
}

async function postSoap(
  handlers: ReturnType<typeof createHttpHandlers>,
  path: string,
  body: string,
): Promise<Response> {
  return (await Promise.resolve(
    handlers.fetch(
      new Request(`http://127.0.0.1:9700${path}`, {
        method: "POST",
        headers: { "content-type": "application/soap+xml" },
        body,
      }),
      stubServer,
    ),
  )) as Response;
}

function resetEnvelope(chargeBoxIdentity: string, messageId: string): string {
  return buildSoapEnvelope({
    operation: "Reset",
    chargeBoxIdentity,
    messageId,
    from: centralSystemUrl,
    to: callbackUrl.replace("/CP/", `/${chargeBoxIdentity}/`),
    payload: { type: "Hard" },
  });
}

function installFakeCentralSystemFetch(
  received: ParsedSoapEnvelope[],
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const requestBody = String(init?.body ?? "");
    const parsed = parseSoapEnvelope(requestBody);
    received.push(parsed);
    const responsePayload = centralSystemResponsePayload(parsed.operation);
    return new Response(
      buildSoapEnvelope({
        operation: parsed.operation,
        kind: "response",
        chargeBoxIdentity: parsed.chargeBoxIdentity ?? cpId,
        messageId: `uuid:conf-${received.length}`,
        from: centralSystemUrl,
        to: parsed.from,
        relatesTo: parsed.messageId,
        payload: responsePayload,
      }),
      { headers: { "content-type": "application/soap+xml" } },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function centralSystemResponsePayload(operation: SoapOperation): SoapPayload {
  if (operation === "BootNotification") {
    return {
      status: "Accepted",
      currentTime: "2026-06-30T00:00:00Z",
      heartbeatInterval: 0,
    };
  }
  return {};
}

function waitForServiceEvent(
  service: CLIChargePointService,
  event: "connected",
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${event}`));
    }, 2_000);
    unsubscribe = service.onEvent((evt) => {
      if (evt.event !== event) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

async function waitUntil(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for assertion");
}
