// Runs under `bun test`: startServer pulls in the `bun:sqlite` built-in.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSoapEnvelope,
  OCPP16_DIALECT,
  parseSoapEnvelope,
} from "../../../cp/infrastructure/transport/soap";
import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import type { SoapTunnel, SoapTunnelOptions } from "../../soapTunnel";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { startServer, type RunningServer } from "../startServer";

/**
 * #183, in the issue's order: "start the local SOAP callback server; start or
 * connect to ngrok; derive the callback URL". The tunnel must find a bound
 * listener, and — the case that bites — a charge point restored from the
 * state DB dials the CSMS during startup and tells it the public callback
 * URL. A CSMS that answers with an immediate command must reach a bound,
 * routed listener, not a port ngrok cannot forward to yet.
 *
 * The tunnel provider is a fake whose "public" origin is the local listener
 * itself, so the fake CSMS below calls the callback URL exactly as a real one
 * would call the ngrok origin.
 */
describe("startServer with --soap-tunnel: listener before tunnel, tunnel before restore (#183)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  it("a restored SOAP charge point's first callback is served", async () => {
    // A CSMS that, on BootNotification, immediately calls the charge point
    // back on the address it announced, and records what it got.
    const callbacks: Array<{ status: number; body: string } | Error> = [];
    // One callback per test: the Reset makes the charge point boot again,
    // and a second round would only repeat the same assertion.
    let calledBack = false;
    const csms = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const parsed = parseSoapEnvelope(await req.text(), OCPP16_DIALECT);
        if (
          parsed.operation === "BootNotification" &&
          parsed.from &&
          !calledBack
        ) {
          calledBack = true;
          const callback = fetch(parsed.from, {
            method: "POST",
            headers: { "content-type": "application/soap+xml" },
            body: buildSoapEnvelope({
              operation: "Reset",
              chargeBoxIdentity: parsed.chargeBoxIdentity ?? "",
              messageId: "uuid:reset-from-csms",
              from: `http://127.0.0.1:${csms.port}/CentralSystemService`,
              to: parsed.from,
              payload: { type: "Soft" },
              dialect: OCPP16_DIALECT,
            }),
          }).then(
            async (res) =>
              callbacks.push({ status: res.status, body: await res.text() }),
            (error: unknown) =>
              callbacks.push(
                error instanceof Error ? error : new Error(String(error)),
              ),
          );
          void callback;
        }
        return new Response(
          buildSoapEnvelope({
            operation: parsed.operation,
            kind: "response",
            chargeBoxIdentity: parsed.chargeBoxIdentity ?? "",
            messageId: `uuid:conf-${callbacks.length}`,
            from: `http://127.0.0.1:${csms.port}/CentralSystemService`,
            to: parsed.from ?? "",
            relatesTo: parsed.messageId,
            payload:
              parsed.operation === "BootNotification"
                ? {
                    status: "Accepted",
                    currentTime: "2026-09-13T00:00:00Z",
                    heartbeatInterval: 0,
                  }
                : {},
            dialect: OCPP16_DIALECT,
          }),
          { headers: { "content-type": "application/soap+xml" } },
        );
      },
    });
    cleanups.push(() => csms.stop(true));
    const csmsUrl = `http://127.0.0.1:${csms.port}/CentralSystemService`;

    // A previous run left a SOAP charge point in the state DB, without a
    // callback URL: it was derived then and must be derived again now.
    const dir = mkdtempSync(join(tmpdir(), "ocpp-cp-sim-183-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const stateDb = join(dir, "state.sqlite");
    {
      const db = BunSqliteDatabase.open(stateDb);
      const seed = new CPRegistry(new EventBus(), db, {
        soapPublicBaseUrl: "https://previous-run.ngrok-free.app",
        soapPath: "/ocpp/soap",
      });
      seed.create(
        {
          cpId: "CP-restored",
          wsUrl: csmsUrl,
          connectors: 1,
          vendor: "V",
          model: "M",
          basicAuth: null,
          ocppVersion: "OCPP-1.6S",
        },
        { seedDefault: false },
      );
      seed.shutdownAll();
      db.close();
    }

    // The tunnel provider sees the listener the daemon bound for it, and
    // publishes that very listener as the "public" origin.
    let listenerStatusAtTunnelStart: number | Error | null = null;
    const startSoapTunnel = async (
      opts: SoapTunnelOptions,
    ): Promise<SoapTunnel> => {
      try {
        const res = await fetch(`http://${opts.localHost}:${opts.localPort}/`);
        listenerStatusAtTunnelStart = res.status;
      } catch (error) {
        listenerStatusAtTunnelStart =
          error instanceof Error ? error : new Error(String(error));
      }
      return {
        provider: "ngrok",
        mode: "spawn",
        publicBaseUrl: `http://${opts.localHost}:${opts.localPort}`,
        localHost: opts.localHost,
        localPort: opts.localPort,
        close: () => {},
      };
    };

    let running: RunningServer | null = null;
    running = await startServer({
      httpPort: 0,
      httpHost: "127.0.0.1",
      pidPath: null,
      bootstrap: null,
      soapPath: "/ocpp/soap",
      soapTunnel: {
        provider: "ngrok",
        authToken: null,
        domain: null,
        apiUrl: null,
        localPort: 0,
      },
      startSoapTunnel,
      autoConnect: false,
      startupScenario: null,
      cors: { kind: "any" },
      staticDir: null,
      webConsolePort: null,
      stateDb,
      healthPath: "/v1/healthz",
      webConsoleBasicAuth: null,
      insecureTlsKeyPerms: false,
    });
    cleanups.push(() => running?.stop());

    // 1. The listener was bound before the tunnel provider ran: the provider
    //    got the listener's own 404, not a refused connection.
    expect(listenerStatusAtTunnelStart).toBe(404);

    // 2. The restored charge point's derived URL points at the tunnel origin.
    const status = (await fetch(
      `http://127.0.0.1:${running.httpPort}/v1/healthz`,
    ).then((res) => res.json())) as { ok?: boolean };
    expect(status.ok).toBe(true);

    // 3. The CSMS's immediate callback reached a bound, routed listener.
    const deadline = Date.now() + 10_000;
    while (callbacks.length === 0 && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(callbacks).toHaveLength(1);
    const callback = callbacks[0];
    if (callback instanceof Error) throw callback;
    expect(callback.status).toBe(200);
    expect(callback.body).toContain("ResetResponse");

    // 4. Only the callback route is published: the daemon's other routes are
    //    absent from the tunnel listener.
    const tunnelPort = running.soapCallbackPort;
    expect(tunnelPort).not.toBeNull();
    for (const path of [
      "/v1/healthz",
      "/socket.io/?EIO=4&transport=polling",
      "/mcp",
      "/",
    ]) {
      const res = await fetch(`http://127.0.0.1:${tunnelPort}${path}`);
      expect(res.status, path).toBe(404);
    }
  });
});
