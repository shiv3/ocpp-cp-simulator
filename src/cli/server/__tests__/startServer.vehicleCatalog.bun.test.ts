/* eslint-disable @typescript-eslint/no-explicit-any -- test ack payloads */
// Runs under `bun test`: a real daemon against a stub Open EV Directory.
import { afterEach, describe, expect, it } from "bun:test";

import id7Curves from "../../../cp/infrastructure/vehicle-catalog/open-ev-directory/__fixtures__/id7GtxChargingCurves.json";
import id7Variant from "../../../cp/infrastructure/vehicle-catalog/open-ev-directory/__fixtures__/id7GtxVariant.json";
import { startServer, type RunningServer } from "../startServer";
import { connectTestClient } from "./socketHarness";

/**
 * #458 end to end on the daemon: the console asks over Socket.IO, the daemon
 * calls the catalog with its own key, and the key reaches the catalog and
 * nothing else. MCP and Socket.IO share the same profile store.
 */

const KEY = "evd_live_SENTINEL_daemon_0123";

const BASE_OPTIONS = {
  httpHost: "127.0.0.1",
  pidPath: null,
  bootstrap: null,
  soapPath: "/ocpp/soap",
  autoConnect: false,
  startupScenario: null,
  cors: { kind: "any" } as const,
  staticDir: null,
  webConsolePort: null,
  healthPath: "/v1/healthz",
  webConsoleBasicAuth: null,
  insecureTlsKeyPerms: false,
  stateDb: null,
};

const PROFILE = {
  id: "vp_1",
  name: "Volkswagen ID.7 GTX",
  specs: {
    usableBatteryKwh: 86,
    acMaxKw: 11,
    acPhases: 3,
    dcMaxKw: 200,
    acConnectors: ["IEC_62196_T2"],
    dcConnectors: ["IEC_62196_T2_COMBO"],
  },
  dcCurve: null,
  overrides: {},
  origin: null,
  createdAt: "2026-10-11T10:00:00.000Z",
  updatedAt: "2026-10-11T10:00:00.000Z",
};

function stubCatalog() {
  const authorizations: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      authorizations.push(req.headers.get("authorization"));
      const path = new URL(req.url).pathname;
      if (path === `/v1/variants/${id7Variant.id}`)
        return Response.json(id7Variant);
      if (path === `/v1/variants/${id7Variant.id}/charging-curves`) {
        return Response.json(id7Curves);
      }
      return Response.json(
        { status: 404, title: "Not found", detail: `nothing at ${path}` },
        {
          status: 404,
          headers: { "content-type": "application/problem+json" },
        },
      );
    },
  });
  return { server, authorizations, url: `http://127.0.0.1:${server.port}` };
}

async function callMcp(port: number, method: string, args: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "call_method", arguments: { method, params: args } },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = JSON.parse(line ? line.slice(6) : text);
  return body.result.content[0].text as string;
}

describe("daemon vehicle catalog (#458)", () => {
  const cleanups: Array<() => unknown> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("imports through the daemon with its key, and shares profiles with MCP", async () => {
    const stub = stubCatalog();
    cleanups.push(() => stub.server.stop(true));
    const running: RunningServer = await startServer({
      ...BASE_OPTIONS,
      httpPort: 0,
      vehicleCatalog: { baseUrl: stub.url, apiKey: KEY },
    });
    cleanups.push(() => running.stop());
    const socket = await connectTestClient(
      `http://127.0.0.1:${running.httpPort}`,
    );
    cleanups.push(() => socket.disconnect());
    const frames: unknown[] = [];
    socket.onAny((...args) => frames.push(args));
    const rpc = (method: string, params: unknown): Promise<any> =>
      new Promise((resolve) => socket.emit("rpc", { method, params }, resolve));

    const info = await rpc("server.info", {});
    expect(info.result.vehicleCatalog).toEqual({
      provider: "open-ev-directory",
      configured: true,
      authenticated: true,
    });

    const variant = await rpc("vehicle_catalog.get_variant", {
      variantId: id7Variant.id,
    });
    expect(variant.ok).toBe(true);
    expect(variant.result.curves).toHaveLength(2);
    expect(stub.authorizations).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);

    const missing = await rpc("vehicle_catalog.get_variant", {
      variantId: "var_0000000000000000",
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "not_found" } });

    expect((await rpc("vehicle_profiles.save", { profile: PROFILE })).ok).toBe(
      true,
    );
    const listed = JSON.parse(
      await callMcp(running.httpPort!, "vehicle_profiles.list", {}),
    );
    expect(listed.map((p: { id: string }) => p.id)).toEqual(["vp_1"]);

    expect(JSON.stringify({ info, variant, missing, frames })).not.toContain(
      KEY,
    );
  });

  it("answers unavailable without a catalog", async () => {
    const running: RunningServer = await startServer({
      ...BASE_OPTIONS,
      httpPort: 0,
    });
    cleanups.push(() => running.stop());
    const text = await callMcp(running.httpPort!, "server.info", {});
    expect(JSON.parse(text).vehicleCatalog).toEqual({
      provider: "open-ev-directory",
      configured: false,
      authenticated: false,
    });
    const socket = await connectTestClient(
      `http://127.0.0.1:${running.httpPort}`,
    );
    cleanups.push(() => socket.disconnect());
    const ack: any = await new Promise((resolve) =>
      socket.emit(
        "rpc",
        { method: "vehicle_catalog.list_makes", params: {} },
        resolve,
      ),
    );
    expect(ack).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("removes the EV settings fields a set_ev_settings patch sets to null", async () => {
    const running: RunningServer = await startServer({
      ...BASE_OPTIONS,
      httpPort: 0,
    });
    cleanups.push(() => running.stop());
    const socket = await connectTestClient(
      `http://127.0.0.1:${running.httpPort}`,
    );
    cleanups.push(() => socket.disconnect());
    const rpc = (
      method: string,
      params: unknown,
      cpId?: string,
    ): Promise<any> =>
      new Promise((resolve) =>
        socket.emit(
          "rpc",
          { ...(cpId ? { cpId } : {}), method, params },
          resolve,
        ),
      );
    expect(
      (
        await rpc("cp.create", {
          cpId: "CP-PATCH",
          wsUrl: "ws://example.test/ocpp/",
          connectors: 1,
          vendor: "V",
          model: "M",
        })
      ).ok,
    ).toBe(true);
    // A profile's vehicle, then a preset's: JSON drops undefined, so only
    // null can remove the curve and the electrical model over the wire.
    await rpc(
      "set_ev_settings",
      {
        connector: 1,
        settings: {
          modelName: "Volkswagen ID.7 GTX",
          currentType: "AC",
          phases: 3,
          chargingCurve: [{ socPercent: 0, powerFraction: 0.5 }],
        },
      },
      "CP-PATCH",
    );
    await rpc(
      "set_ev_settings",
      {
        connector: 1,
        settings: {
          modelName: "Tesla Model 3",
          chargingCurve: null,
          currentType: null,
          phases: null,
        },
      },
      "CP-PATCH",
    );
    const ack = await rpc("get_ev_settings", { connector: 1 }, "CP-PATCH");
    expect(ack.ok).toBe(true);
    expect(ack.result.modelName).toBe("Tesla Model 3");
    expect("chargingCurve" in ack.result).toBe(false);
    expect("currentType" in ack.result).toBe(false);
    expect("phases" in ack.result).toBe(false);
    expect(JSON.stringify(ack.result)).not.toContain("null");
  });
});
