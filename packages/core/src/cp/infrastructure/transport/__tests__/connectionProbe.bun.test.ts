import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type AddressInfo } from "node:net";

import { probeConnection } from "../ws/connectionProbe";
import { LOOPBACK, tcpPort } from "../../../../test/bunServe";

/**
 * #1132 under Bun's native client, which the daemon uses. It hides the status
 * of a refused upgrade (1.4.3: `1002 Expected 101 status code`), so the probe
 * asks with the diagnostic GET; it says `Failed to connect` for both a closed
 * port and an unknown host, so the probe resolves the name to tell them apart.
 */

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function track(server: { port?: number; stop(force?: boolean): unknown }) {
  stops.push(() => void server.stop(true));
  return tcpPort(server);
}

const probe = (url: string, extra: Record<string, unknown> = {}) =>
  probeConnection({
    baseUrl: url,
    chargePointId: "CP001",
    ocppVersion: "OCPP-1.6J",
    basicAuth: null,
    timeoutMs: 3000,
    ...extra,
  });

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, LOOPBACK, () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A WebSocket endpoint answering with `headers` on the 101, if any. */
function upgrading(onMessage: () => void, headers?: Record<string, string>) {
  return track(
    Bun.serve({
      port: 0,
      hostname: LOOPBACK,
      fetch(req, server) {
        if (server.upgrade(req, { data: undefined, headers })) return undefined;
        return new Response("", { status: 400 });
      },
      websocket: { message: onMessage },
    }),
  );
}

function answering(response: () => Response) {
  return track(Bun.serve({ port: 0, hostname: LOOPBACK, fetch: response }));
}

describe("probeConnection under Bun (#1132)", () => {
  it("opens with the agreed subprotocol and sends no message", async () => {
    let messages = 0;
    const port = upgrading(() => (messages += 1));
    const result = await probe(`ws://127.0.0.1:${port}/ocpp/`);
    expect(result).toMatchObject({
      ok: true,
      code: "ok",
      subprotocol: "ocpp1.6",
    });
    expect(messages).toBe(0);
  });

  it("learns the status of a refused upgrade with the diagnostic GET", async () => {
    const port = answering(() => new Response("", { status: 401 }));
    expect(await probe(`ws://127.0.0.1:${port}/ocpp`)).toMatchObject({
      code: "credentials_refused",
      httpStatus: 401,
    });
  });

  it("reports a plain HTTP server as not_websocket", async () => {
    const port = answering(() => new Response("hello"));
    expect(await probe(`ws://127.0.0.1:${port}/ocpp`)).toMatchObject({
      code: "not_websocket",
      httpStatus: 200,
    });
  });

  it("reports a subprotocol the CSMS did not agree to", async () => {
    const port = upgrading(() => {}, {
      "Sec-WebSocket-Protocol": "ocpp2.0.1",
    });
    expect(await probe(`ws://127.0.0.1:${port}/ocpp`)).toMatchObject({
      code: "subprotocol_not_agreed",
      stage: "subprotocol",
    });
  });

  it("tells a closed port from a name that does not resolve", async () => {
    const port = await closedPort();
    expect(await probe(`ws://127.0.0.1:${port}/ocpp`)).toMatchObject({
      code: "connection_refused",
      stage: "tcp",
    });
    const unresolved = await probeConnection(
      {
        baseUrl: `ws://localhost:${port}/ocpp`,
        chargePointId: "CP001",
        basicAuth: null,
        timeoutMs: 3000,
      },
      { lookup: () => Promise.reject(new Error("ENOTFOUND")) },
    );
    // Bun 1.4.4 carries ECONNREFUSED on the error event, which needs no
    // lookup; earlier versions carry nothing, and the failed lookup decides.
    expect(unresolved.code).toBe(
      Bun.semver.satisfies(Bun.version, "<1.4.4")
        ? "dns_failure"
        : "connection_refused",
    );
  });
});
