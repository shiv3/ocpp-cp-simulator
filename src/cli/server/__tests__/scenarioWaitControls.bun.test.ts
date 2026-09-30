/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";
import { parkingScenario } from "../../__tests__/parkingScenario";

/**
 * #240: extend_scenario_wait / retry_scenario_wait / continue_scenario_wait
 * over the wire, and the invalid_params answer for a run that is not
 * running or not waiting.
 */
const CONNECTOR = 1;
const CP_ID = "CPWAIT";

const scenario = parkingScenario("wait-controls-contract", { timeout: 60 });

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

function rpc(
  socket: Socket,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  return socket
    .timeout(5_000)
    .emitWithAck("rpc", { cpId: CP_ID, method, params });
}

async function withParkedRun(fn: (socket: Socket) => Promise<void>) {
  const server = await startTestServer();
  servers.push(server);
  const socket = await connectTestClient(server);
  try {
    server.registry.create(
      {
        cpId: CP_ID,
        wsUrl: "ws://127.0.0.1:65534/never",
        connectors: 1,
        vendor: "test",
        model: "test",
        basicAuth: null,
      },
      { seedDefault: false },
    );
    const target = { connector: CONNECTOR, scenarioId: scenario.id };
    expect(
      (
        await rpc(socket, "load_scenario", {
          connector: CONNECTOR,
          scenario,
        })
      ).ok,
    ).toBe(true);
    expect(
      (await rpc(socket, "run_scenario", { ...target, awaitArmed: true })).ok,
    ).toBe(true);
    await fn(socket);
  } finally {
    socket.disconnect();
  }
}

const target = { connector: CONNECTOR, scenarioId: scenario.id };

describe("#240 wait controls over RPC", () => {
  it("extends, retries and continues a parked run", async () => {
    await withParkedRun(async (socket) => {
      const before = (await rpc(socket, "scenario_status", target)).result;
      expect(before.state).toBe("waiting");
      expect(typeof before.waitDeadlineAt).toBe("number");

      expect(
        (await rpc(socket, "extend_scenario_wait", { ...target, seconds: 30 }))
          .ok,
      ).toBe(true);
      const extended = (await rpc(socket, "scenario_status", target)).result;
      expect(extended.waitDeadlineAt).toBe(before.waitDeadlineAt + 30_000);

      expect((await rpc(socket, "retry_scenario_wait", target)).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect((await rpc(socket, "continue_scenario_wait", target)).ok).toBe(
        true,
      );
      await new Promise((r) => setTimeout(r, 50));

      const done = (await rpc(socket, "scenario_status", target)).result;
      expect(done.state).toBe("completed");
      const report = (await rpc(socket, "scenario_report", target)).result;
      expect(report.interventions.map((i: any) => i.kind)).toEqual([
        "extend",
        "retry",
        "continue",
      ]);

      // The run is over: a control on it is a caller error, not `internal`.
      expect(await rpc(socket, "continue_scenario_wait", target)).toMatchObject(
        { ok: false, error: { code: "invalid_params" } },
      );
      expect(await rpc(socket, "stop_scenario", target)).toMatchObject({
        ok: false,
        error: { code: "invalid_params" },
      });
    });
  }, 20_000);

  it("answers invalid_params, with the reason, for an unknown scenario", async () => {
    await withParkedRun(async (socket) => {
      expect(
        await rpc(socket, "retry_scenario_wait", {
          connector: CONNECTOR,
          scenarioId: "no-such-scenario",
        }),
      ).toMatchObject({
        ok: false,
        error: {
          code: "invalid_params",
          message: "Scenario no-such-scenario not found",
        },
      });
      await rpc(socket, "stop_scenario", target);
    });
  }, 20_000);

  it("rejects a non-positive extension before it reaches the run", async () => {
    await withParkedRun(async (socket) => {
      expect(
        await rpc(socket, "extend_scenario_wait", { ...target, seconds: 0 }),
      ).toMatchObject({ ok: false, error: { code: "invalid_params" } });
      await rpc(socket, "stop_scenario", target);
    });
  }, 20_000);
});
