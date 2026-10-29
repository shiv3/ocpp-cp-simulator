/* eslint-disable @typescript-eslint/no-explicit-any -- test ack payloads */
// Runs under `bun test`: a real daemon, driven over Socket.IO.
import { afterEach, describe, expect, it } from "bun:test";

import { defaultEVSettings } from "../../../cp/domain/connector/EVSettings";
import { startServer, type RunningServer } from "../startServer";
import { connectTestClient } from "./socketHarness";

/**
 * #333: `ev_settings.apply_default` merges its payload onto the built-in
 * `defaultEVSettings`, as `set_ev_settings` merges onto the current settings.
 * A field the client omits reads back as the built-in default instead of
 * disappearing from the connector.
 */

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

describe("ev_settings.apply_default (#333)", () => {
  const cleanups: Array<() => unknown> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function daemonWithOneCp() {
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
    const created = await rpc("cp.create", {
      cpId: "CP-DEFAULT",
      wsUrl: "ws://example.test/ocpp/",
      connectors: 1,
      vendor: "V",
      model: "M",
    });
    expect(created.ok).toBe(true);
    return rpc;
  }

  it("reads omitted fields back as the built-in defaults after a partial payload", async () => {
    const rpc = await daemonWithOneCp();
    // A complete default that moves every required field off the built-in.
    expect(
      (
        await rpc("ev_settings.apply_default", {
          settings: {
            modelName: "Full EV",
            batteryCapacityKwh: 40,
            maxChargingPowerKw: 11,
            initialSoc: 35,
            targetSoc: 90,
            chargingCurve: [{ socPercent: 0, powerFraction: 0.5 }],
          },
        })
      ).ok,
    ).toBe(true);

    // Then a partial one: only the model and the target.
    const ack = await rpc("ev_settings.apply_default", {
      settings: { modelName: "Partial EV", targetSoc: 70 },
    });
    expect(ack.ok).toBe(true);

    const read = await rpc("get_ev_settings", { connector: 1 }, "CP-DEFAULT");
    expect(read.ok).toBe(true);
    expect(read.result).toEqual({
      ...defaultEVSettings,
      modelName: "Partial EV",
      targetSoc: 70,
    });
  });

  it("refuses a payload that sets a required field to null, and changes nothing", async () => {
    const rpc = await daemonWithOneCp();
    const before = await rpc("get_ev_settings", { connector: 1 }, "CP-DEFAULT");

    const refused = await rpc("ev_settings.apply_default", {
      settings: { initialSoc: null, modelName: "Kept out" },
    });
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "invalid_params",
        message: expect.stringContaining("initialSoc cannot be removed"),
      },
    });

    const after = await rpc("get_ev_settings", { connector: 1 }, "CP-DEFAULT");
    expect(after.result).toEqual(before.result);
  });
});
