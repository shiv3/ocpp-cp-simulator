import { describe, expect, it } from "bun:test";

import {
  buildSoapEnvelope,
  OCPP12_DIALECT,
  OCPP12_SOAP_NAMESPACES,
  OCPP16_DIALECT,
  OCPP16_SOAP_NAMESPACES,
  parseSoapEnvelope,
} from "../../../cp/infrastructure/transport/soap";
import type {
  ParsedSoapEnvelope,
  SoapDialect,
  SoapOperation,
  SoapPayload,
} from "../../../cp/infrastructure/transport/soap";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createHttpHandlers } from "../httpServer";
import { createLifecycle } from "../lifecycle";
import type { CLIChargePointService } from "../../service";
import { MAX_SOAP_REQUEST_BODY_BYTES } from "../httpServer";

type FetchServer = Parameters<
  ReturnType<typeof createHttpHandlers>["fetch"]
>[1];

const stubServer = null as unknown as FetchServer;
const cpId = "CP";
const callbackUrl = "http://127.0.0.1:9700/ocpp/soap/CP/ChargePointService";
const centralSystemUrl = "http://csms.example/CentralSystemService";
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

describe("httpServer OCPP 1.5 SOAP ChargePointService", () => {
  it("accepts Reset for a registered CP, relates the response, and applies reset", async () => {
    await withGlobalFetch(async () => {
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
      expect(mismatch.status).toBe(400);
      expect(mismatchBody).toContain("<s:Fault>");
      expect(mismatchBody).toContain("chargeBoxIdentity");

      const unknown = await postSoap(
        handlers,
        "/ocpp/soap/MISSING/ChargePointService",
        resetEnvelope("MISSING", "uuid:reset-unknown"),
      );
      const unknownBody = await unknown.text();
      expect(unknown.status).toBe(404);
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
      expect(res.status).toBe(400);
      expect(body).toContain("<s:Fault>");
      expect(body).toContain("DOCTYPE or ENTITY");
    } finally {
      registry.shutdownAll();
    }
  });

  it("rejects oversized SOAP bodies from Content-Length before parsing", async () => {
    const registry = createRegistry();
    const handlers = createHandlers(registry);
    registry.create(soapCpInit(cpId), { seedDefault: false });

    try {
      const res = await postSoap(
        handlers,
        "/ocpp/soap/CP/ChargePointService",
        "<not-soap/>",
        { "content-length": String(MAX_SOAP_REQUEST_BODY_BYTES + 1) },
      );
      const body = await res.text();

      expect(res.status).toBe(413);
      expect(body).toContain("<s:Fault>");
      expect(body).toContain("too large");
    } finally {
      registry.shutdownAll();
    }
  });

  it("routes SOAP callbacks on the registered custom soapPath", async () => {
    await withGlobalFetch(async () => {
      const registry = createRegistry();
      const handlers = createHandlers(registry);
      const soapPosts: ParsedSoapEnvelope[] = [];
      const restoreFetch = installFakeCentralSystemFetch(soapPosts);
      registry.create(
        {
          ...soapCpInit(cpId),
          soapCallbackUrl:
            "http://127.0.0.1:9700/custom/soap/CP/ChargePointService",
          soapPath: "/custom/soap",
        },
        { seedDefault: false },
      );

      try {
        const defaultPath = await postSoap(
          handlers,
          "/ocpp/soap/CP/ChargePointService",
          resetEnvelope("CP", "uuid:reset-default-path"),
        );
        expect(defaultPath.status).toBe(404);

        const customPath = await postSoap(
          handlers,
          "/custom/soap/CP/ChargePointService",
          resetEnvelope(
            "CP",
            "uuid:reset-custom-path",
            "http://127.0.0.1:9700/custom/soap/CP/ChargePointService",
          ),
        );
        const body = await customPath.text();
        const parsed = parseSoapEnvelope(body);

        expect(customPath.status).toBe(200);
        expect(parsed).toMatchObject({
          operation: "Reset",
          kind: "response",
          relatesTo: "uuid:reset-custom-path",
          payload: { status: "Accepted" },
        });
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
  });

  it("rejects a registered non-SOAP CP before parsing inbound SOAP XML", async () => {
    const registry = createRegistry();
    const handlers = createHandlers(registry);
    registry.create(jsonCpInit("JSON-CP"), { seedDefault: false });

    try {
      const res = await postSoap(
        handlers,
        "/ocpp/soap/JSON-CP/ChargePointService",
        "<not-soap",
      );
      const body = await res.text();

      expect(res.status).toBe(400);
      expect(body).toContain("<s:Fault>");
      expect(body).toContain("not configured for OCPP SOAP");
    } finally {
      registry.shutdownAll();
    }
  });
});

describe("httpServer OCPP 1.2 SOAP ChargePointService", () => {
  const cp12Id = "CP12";

  it("accepts a 1.2-dialect Reset for a 1.2 CP and answers in the 1.2 namespace", async () => {
    await withGlobalFetch(async () => {
      const registry = createRegistry();
      const handlers = createHandlers(registry);
      const service = registry.create(
        { ...soapCpInit(cp12Id), ocppVersion: "OCPP-1.2" },
        { seedDefault: false },
      );
      const soapPosts: ParsedSoapEnvelope[] = [];
      const restoreFetch = installFakeCentralSystemFetch(
        soapPosts,
        OCPP12_DIALECT,
      );

      try {
        const resetApplied = waitForServiceEvent(service, "connected");
        const res = await postSoap(
          handlers,
          `/ocpp/soap/${cp12Id}/ChargePointService`,
          resetEnvelope(cp12Id, "uuid:reset-12", undefined, OCPP12_DIALECT),
        );
        const body = await res.text();

        expect(res.status).toBe(200);
        expect(body).toContain(OCPP12_SOAP_NAMESPACES.CP);
        const parsed = parseSoapEnvelope(body, OCPP12_DIALECT);
        expect(parsed).toMatchObject({
          operation: "Reset",
          kind: "response",
          action: "/ResetResponse",
          relatesTo: "uuid:reset-12",
          chargeBoxIdentity: cp12Id,
          namespace: OCPP12_SOAP_NAMESPACES.CP,
          payload: { status: "Accepted" },
        });

        // The reboot drives the 1.2 CP→CS client end-to-end (2010/08 wire).
        await resetApplied;
        await waitUntil(() =>
          soapPosts.some(
            (post) =>
              post.operation === "BootNotification" &&
              post.namespace === OCPP12_SOAP_NAMESPACES.CS,
          ),
        );
      } finally {
        registry.shutdownAll();
        restoreFetch();
      }
    });
  });

  it("faults a 1.5-namespace Reset sent to a 1.2 CP", async () => {
    const registry = createRegistry();
    const handlers = createHandlers(registry);
    registry.create(
      { ...soapCpInit(cp12Id), ocppVersion: "OCPP-1.2" },
      { seedDefault: false },
    );

    try {
      const res = await postSoap(
        handlers,
        `/ocpp/soap/${cp12Id}/ChargePointService`,
        resetEnvelope(cp12Id, "uuid:reset-ns-mismatch"),
      );
      const body = await res.text();

      expect(res.status).toBe(400);
      expect(body).toContain("<s:Fault>");
      expect(body).toContain(OCPP12_SOAP_NAMESPACES.CP);
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

function jsonCpInit(id: string) {
  return {
    cpId: id,
    wsUrl: "ws://csms.example/ocpp",
    centralSystemUrl: "ws://csms.example/ocpp",
    connectors: 1,
    vendor: "TestVendor",
    model: "TestModel",
    basicAuth: null,
    ocppVersion: "OCPP-1.6J",
    soapPath: "/ocpp/soap",
  };
}

async function postSoap(
  handlers: ReturnType<typeof createHttpHandlers>,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return (await Promise.resolve(
    handlers.fetch(
      new Request(`http://127.0.0.1:9700${path}`, {
        method: "POST",
        headers: { "content-type": "application/soap+xml", ...headers },
        body,
      }),
      stubServer,
    ),
  )) as Response;
}

function resetEnvelope(
  chargeBoxIdentity: string,
  messageId: string,
  to = callbackUrl.replace("/CP/", `/${chargeBoxIdentity}/`),
  dialect?: SoapDialect,
): string {
  return buildSoapEnvelope({
    operation: "Reset",
    chargeBoxIdentity,
    messageId,
    from: centralSystemUrl,
    to,
    payload: { type: "Hard" },
    ...(dialect ? { dialect } : {}),
  });
}

function installFakeCentralSystemFetch(
  received: ParsedSoapEnvelope[],
  dialect?: SoapDialect,
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const requestBody = String(init?.body ?? "");
    const parsed = parseSoapEnvelope(requestBody, dialect);
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
        ...(dialect ? { dialect } : {}),
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

describe("httpServer OCPP 1.6-SOAP + 1.2 CS→CP dispatch (v16 registry)", () => {
  it("1.2 CP accepts ChangeAvailability via v16 registry dispatch", async () => {
    const registry = createRegistry();
    const handlers = createHandlers(registry);
    const cp12Id = "CP-12";
    registry.create(
      { ...soapCpInit(cp12Id), ocppVersion: "OCPP-1.2" },
      { seedDefault: false },
    );

    try {
      const res = await postSoap(
        handlers,
        `/ocpp/soap/${cp12Id}/ChargePointService`,
        buildSoapEnvelope({
          operation: "ChangeAvailability",
          chargeBoxIdentity: cp12Id,
          messageId: "uuid:ca-12-1",
          from: centralSystemUrl,
          to: `http://127.0.0.1:9700/ocpp/soap/${cp12Id}/ChargePointService`,
          payload: { connectorId: "1", type: "Operative" },
          dialect: OCPP12_DIALECT,
        }),
      );
      const body = await res.text();
      const parsed = parseSoapEnvelope(body, OCPP12_DIALECT);

      expect(res.status).toBe(200);
      expect(parsed).toMatchObject({
        operation: "ChangeAvailability",
        kind: "response",
        relatesTo: "uuid:ca-12-1",
        chargeBoxIdentity: cp12Id,
        payload: { status: "Accepted" },
      });
    } finally {
      registry.shutdownAll();
    }
  });
});

describe("httpServer OCPP 1.6 SOAP ChargePointService", () => {
  const cp16Id = "CP16";

  it("accepts TriggerMessage and posts StatusNotification to fake CSMS", async () => {
    await withGlobalFetch(async () => {
      const registry = createRegistry();
      const handlers = createHandlers(registry);
      const service = registry.create(
        { ...soapCpInit(cp16Id), ocppVersion: "OCPP-1.6S" },
        { seedDefault: false },
      );
      const soapPosts: ParsedSoapEnvelope[] = [];
      const restoreFetch = installFakeCentralSystemFetch(
        soapPosts,
        OCPP16_DIALECT,
      );

      try {
        // First, send a Reset to connect the CP
        const resetConnectedPromise = waitForServiceEvent(service, "connected");
        await postSoap(
          handlers,
          `/ocpp/soap/${cp16Id}/ChargePointService`,
          buildSoapEnvelope({
            operation: "Reset",
            chargeBoxIdentity: cp16Id,
            messageId: "uuid:reset-connect",
            from: centralSystemUrl,
            to: `http://127.0.0.1:9700/ocpp/soap/${cp16Id}/ChargePointService`,
            payload: { type: "Hard" },
            dialect: OCPP16_DIALECT,
          }),
        );
        await resetConnectedPromise;

        // Now send TriggerMessage
        const res = await postSoap(
          handlers,
          `/ocpp/soap/${cp16Id}/ChargePointService`,
          buildSoapEnvelope({
            operation: "TriggerMessage",
            chargeBoxIdentity: cp16Id,
            messageId: "uuid:trigger-1",
            from: centralSystemUrl,
            to: `http://127.0.0.1:9700/ocpp/soap/${cp16Id}/ChargePointService`,
            payload: { requestedMessage: "StatusNotification" },
            dialect: OCPP16_DIALECT,
          }),
        );
        const body = await res.text();
        const parsed = parseSoapEnvelope(body, OCPP16_DIALECT);

        expect(res.status).toBe(200);
        expect(parsed).toMatchObject({
          operation: "TriggerMessage",
          kind: "response",
          relatesTo: "uuid:trigger-1",
          chargeBoxIdentity: cp16Id,
          payload: { status: "Accepted" },
        });

        await waitUntil(() =>
          soapPosts.some(
            (post) =>
              post.operation === "StatusNotification" &&
              post.namespace === OCPP16_SOAP_NAMESPACES.CS,
          ),
        );
      } finally {
        registry.shutdownAll();
        restoreFetch();
      }
    });
  });

  it("accepts RemoteStartTransaction and posts StartTransaction to fake CSMS", async () => {
    await withGlobalFetch(async () => {
      const registry = createRegistry();
      const handlers = createHandlers(registry);
      const service = registry.create(
        { ...soapCpInit(cp16Id), ocppVersion: "OCPP-1.6S" },
        { seedDefault: false },
      );
      const soapPosts: ParsedSoapEnvelope[] = [];
      const restoreFetch = installFakeCentralSystemFetch(
        soapPosts,
        OCPP16_DIALECT,
      );

      try {
        // First, send a Reset to connect the CP
        const resetConnectedPromise = waitForServiceEvent(service, "connected");
        await postSoap(
          handlers,
          `/ocpp/soap/${cp16Id}/ChargePointService`,
          buildSoapEnvelope({
            operation: "Reset",
            chargeBoxIdentity: cp16Id,
            messageId: "uuid:reset-connect",
            from: centralSystemUrl,
            to: `http://127.0.0.1:9700/ocpp/soap/${cp16Id}/ChargePointService`,
            payload: { type: "Hard" },
            dialect: OCPP16_DIALECT,
          }),
        );
        await resetConnectedPromise;

        // Now send RemoteStartTransaction
        const res = await postSoap(
          handlers,
          `/ocpp/soap/${cp16Id}/ChargePointService`,
          buildSoapEnvelope({
            operation: "RemoteStartTransaction",
            chargeBoxIdentity: cp16Id,
            messageId: "uuid:rst-1",
            from: centralSystemUrl,
            to: `http://127.0.0.1:9700/ocpp/soap/${cp16Id}/ChargePointService`,
            payload: { idTag: "TAG-16", connectorId: 1 },
            dialect: OCPP16_DIALECT,
          }),
        );
        const body = await res.text();
        const parsed = parseSoapEnvelope(body, OCPP16_DIALECT);

        expect(res.status).toBe(200);
        expect(parsed).toMatchObject({
          operation: "RemoteStartTransaction",
          kind: "response",
          relatesTo: "uuid:rst-1",
          chargeBoxIdentity: cp16Id,
          payload: { status: "Accepted" },
        });

        await waitUntil(() =>
          soapPosts.some(
            (post) =>
              post.operation === "StartTransaction" &&
              post.namespace === OCPP16_SOAP_NAMESPACES.CS,
          ),
        );
      } finally {
        registry.shutdownAll();
        restoreFetch();
      }
    });
  });

  it("rejects out-of-dialect TriggerMessage sent to 1.2 CP with SOAP Fault", async () => {
    const registry = createRegistry();
    const handlers = createHandlers(registry);
    const cp12Id = "CP12";
    registry.create(
      { ...soapCpInit(cp12Id), ocppVersion: "OCPP-1.2" },
      { seedDefault: false },
    );

    try {
      // Build a TriggerMessage envelope with 1.6 dialect
      const triggerEnvelope = buildSoapEnvelope({
        operation: "TriggerMessage",
        chargeBoxIdentity: cp12Id,
        messageId: "uuid:trigger-invalid",
        from: centralSystemUrl,
        to: `http://127.0.0.1:9700/ocpp/soap/${cp12Id}/ChargePointService`,
        payload: { requestedMessage: "StatusNotification" },
        dialect: OCPP16_DIALECT,
      });

      const res = await postSoap(
        handlers,
        `/ocpp/soap/${cp12Id}/ChargePointService`,
        triggerEnvelope,
      );
      const body = await res.text();

      // Expect a fault (status 400) because TriggerMessage is not in 1.2 dialect
      expect(res.status).toBe(400);
      expect(body).toContain("<s:Fault>");
      // The fault should indicate the wrapper is not recognized in the 1.2 dialect
      expect(body).toContain("triggerMessageRequest");
    } finally {
      registry.shutdownAll();
    }
  });

  it("transforms 1.2 UnlockConnector response to only Accepted/Rejected", async () => {
    const registry = createRegistry();
    const handlers = createHandlers(registry);
    const cp12Id = "CP12";
    registry.create(
      { ...soapCpInit(cp12Id), ocppVersion: "OCPP-1.2" },
      { seedDefault: false },
    );

    try {
      const res = await postSoap(
        handlers,
        `/ocpp/soap/${cp12Id}/ChargePointService`,
        buildSoapEnvelope({
          operation: "UnlockConnector",
          chargeBoxIdentity: cp12Id,
          messageId: "uuid:unlock-12",
          from: centralSystemUrl,
          to: `http://127.0.0.1:9700/ocpp/soap/${cp12Id}/ChargePointService`,
          payload: { connectorId: 1 },
          dialect: OCPP12_DIALECT,
        }),
      );
      const body = await res.text();
      const parsed = parseSoapEnvelope(body, OCPP12_DIALECT);

      expect(res.status).toBe(200);
      expect(parsed).toMatchObject({
        operation: "UnlockConnector",
        kind: "response",
        chargeBoxIdentity: cp12Id,
      });
      const status = parsed.payload.status as string;
      expect(["Accepted", "Rejected"]).toContain(status);
      expect(["Unlocked", "UnlockFailed", "NotSupported"]).not.toContain(
        status,
      );
    } finally {
      registry.shutdownAll();
    }
  });
});
