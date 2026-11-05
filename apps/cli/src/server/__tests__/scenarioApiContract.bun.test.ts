/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

/**
 * Wire-level contract for the three API problems found verifying v0.7.5 over
 * RPC/MCP:
 *
 * - `load_scenario` accepted a definition with no `id`, answered `{}` instead of
 *   `{ scenarioId }`, and left an entry in `list_scenarios` that could be
 *   neither run nor removed. It must be `invalid_params`.
 * - `logs.get {limit}` returned the OLDEST n, so no limit could reach recent
 *   activity on a charge point that had been up for days.
 * - `scenario_status` went null the moment a run ended, so a poller waiting for
 *   `completed` never saw it and could not tell that from an unknown id.
 */
const CONNECTOR = 1;

const validScenario = {
  id: "contract-scenario",
  name: "Contract scenario",
  targetType: "connector",
  targetId: CONNECTOR,
  trigger: { type: "manual" },
  enabled: true,
  nodes: [
    {
      id: "s",
      type: "start",
      position: { x: 0, y: 0 },
      data: { label: "S" },
    },
    {
      id: "e",
      type: "end",
      position: { x: 0, y: 1 },
      data: { label: "E" },
    },
  ],
  edges: [{ id: "e1", source: "s", target: "e" }],
  createdAt: "2026-07-30T00:00:00Z",
  updatedAt: "2026-07-30T00:00:00Z",
};

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(5_000).emitWithAck("rpc", request);
}

async function withDaemon(
  cpId: string,
  fn: (socket: Socket, server: TestServer) => Promise<void>,
): Promise<void> {
  const server = await startTestServer();
  servers.push(server);
  const socket = await connectTestClient(server);
  try {
    // No CSMS needed: nothing here connects the charge point.
    server.registry.create(
      {
        cpId,
        wsUrl: "ws://127.0.0.1:65534/never",
        connectors: 1,
        vendor: "test",
        model: "test",
        basicAuth: null,
      },
      { seedDefault: false },
    );
    await fn(socket, server);
  } finally {
    socket.disconnect();
  }
}

describe("load_scenario rejects an incomplete inline definition", () => {
  it("answers invalid_params instead of loading id-less garbage", async () => {
    await withDaemon("CPCONTRACT1", async (socket) => {
      const { id: _id, ...noId } = validScenario;
      const ack = await emitRpc(socket, {
        cpId: "CPCONTRACT1",
        method: "load_scenario",
        params: { connector: CONNECTOR, scenario: noId },
      });

      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");

      // And nothing was half-loaded.
      const list = await emitRpc(socket, {
        cpId: "CPCONTRACT1",
        method: "list_scenarios",
        params: { connector: CONNECTOR },
      });
      expect(list.result).toEqual([]);
    });
  });

  it("rejects a missing targetType the same way", async () => {
    await withDaemon("CPCONTRACT2", async (socket) => {
      const { targetType: _t, ...noTargetType } = validScenario;
      const ack = await emitRpc(socket, {
        cpId: "CPCONTRACT2",
        method: "load_scenario",
        params: { connector: CONNECTOR, scenario: noTargetType },
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");
    });
  });

  it("still accepts a complete definition and returns its scenarioId", async () => {
    await withDaemon("CPCONTRACT3", async (socket) => {
      const ack = await emitRpc(socket, {
        cpId: "CPCONTRACT3",
        method: "load_scenario",
        params: { connector: CONNECTOR, scenario: validScenario },
      });
      expect(ack.ok).toBe(true);
      expect(ack.result).toEqual({ scenarioId: validScenario.id });

      const list = await emitRpc(socket, {
        cpId: "CPCONTRACT3",
        method: "list_scenarios",
        params: { connector: CONNECTOR },
      });
      expect(list.result).toHaveLength(1);
      expect(list.result[0].scenarioId).toBe(validScenario.id);
      // #240 fields are present even before the first run.
      expect(list.result[0]).toHaveProperty("state");
      expect(list.result[0]).toHaveProperty("mode");
    });
  });
});

describe("logs.get returns the most recent entries", () => {
  it("answers a limit with the newest n, chronologically", async () => {
    await withDaemon("CPLOGS", async (socket) => {
      // Generate log traffic deterministically: a scenario run emits its
      // start/complete lines through the CP logger, no CSMS required.
      await emitRpc(socket, {
        cpId: "CPLOGS",
        method: "load_scenario",
        params: { connector: CONNECTOR, scenario: validScenario },
      });
      await emitRpc(socket, {
        cpId: "CPLOGS",
        method: "run_scenario",
        params: { connector: CONNECTOR, scenarioId: validScenario.id },
      });
      await new Promise((r) => setTimeout(r, 200));

      const all = (
        await emitRpc(socket, {
          method: "logs.get",
          params: { cpId: "CPLOGS" },
        })
      ).result as Array<{ message: string }>;

      // Fail loudly rather than pass vacuously if the run stops logging.
      expect(all.length).toBeGreaterThan(1);

      const tail = (
        await emitRpc(socket, {
          method: "logs.get",
          params: { cpId: "CPLOGS", limit: 1 },
        })
      ).result as Array<{ message: string }>;
      expect(tail).toHaveLength(1);
      expect(tail[0].message).toBe(all[all.length - 1].message);

      const desc = (
        await emitRpc(socket, {
          method: "logs.get",
          params: { cpId: "CPLOGS", limit: 2, order: "desc" },
        })
      ).result as Array<{ message: string }>;
      expect(desc).toHaveLength(2);
      expect(desc[0].message).toBe(all[all.length - 1].message);
      expect(desc[1].message).toBe(all[all.length - 2].message);

      const paged = (
        await emitRpc(socket, {
          method: "logs.get",
          params: { cpId: "CPLOGS", limit: 1, offset: 1 },
        })
      ).result as Array<{ message: string }>;
      expect(paged).toHaveLength(1);
      expect(paged[0].message).toBe(all[all.length - 2].message);
    });
  });

  it("rejects a bad order value rather than silently ignoring it", async () => {
    await withDaemon("CPLOGSBAD", async (socket) => {
      const ack = await emitRpc(socket, {
        method: "logs.get",
        params: { cpId: "CPLOGSBAD", order: "sideways" },
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");
    });
  });
});

describe("scenario_status survives the end of a run", () => {
  it("reports a terminal state and runId a poller can observe", async () => {
    await withDaemon("CPSTATUS", async (socket) => {
      const cpId = "CPSTATUS";
      expect(
        (
          await emitRpc(socket, {
            cpId,
            method: "load_scenario",
            params: { connector: CONNECTOR, scenario: validScenario },
          })
        ).ok,
      ).toBe(true);

      // An unknown id is null — that's what distinguishes it from "finished".
      expect(
        (
          await emitRpc(socket, {
            cpId,
            method: "scenario_status",
            params: { connector: CONNECTOR, scenarioId: "no-such-scenario" },
          })
        ).result ?? null,
      ).toBeNull();

      expect(
        (
          await emitRpc(socket, {
            cpId,
            method: "run_scenario",
            params: { connector: CONNECTOR, scenarioId: validScenario.id },
          })
        ).ok,
      ).toBe(true);

      // Poll the way a headless runner would. This used to spin until timeout.
      let status: { state?: string; runId?: string } | null = null;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        status = (
          await emitRpc(socket, {
            cpId,
            method: "scenario_status",
            params: { connector: CONNECTOR, scenarioId: validScenario.id },
          })
        ).result;
        if (status?.state === "completed") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(status?.state).toBe("completed");
      expect(status?.runId).toBeTruthy();

      // And it agrees with the report.
      const report = (
        await emitRpc(socket, {
          cpId,
          method: "scenario_report",
          params: { connector: CONNECTOR, scenarioId: validScenario.id },
        })
      ).result;
      expect(report.runId).toBe(status!.runId);
      expect(report.executionState).toBe(status!.state);

      // Removing the scenario drops the terminal state again.
      expect(
        (
          await emitRpc(socket, {
            cpId,
            method: "remove_scenario",
            params: { connector: CONNECTOR, scenarioId: validScenario.id },
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await emitRpc(socket, {
            cpId,
            method: "scenario_status",
            params: { connector: CONNECTOR, scenarioId: validScenario.id },
          })
        ).result ?? null,
      ).toBeNull();
    });
  }, 20_000);
});
