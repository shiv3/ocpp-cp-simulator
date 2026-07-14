/* eslint-disable @typescript-eslint/no-explicit-any -- ack/report payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "socket.io-client";

import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

/**
 * Issue #111: exercise the exact Socket.IO control-plane sequence an external
 * JVM/Testcontainers harness uses (examples/testcontainers-java) — cp.create →
 * load_scenario (inline) → run_scenario → scenario_report — and assert the
 * machine-readable PASS verdict (#179). This runs the real socket server, so it
 * both validates the documented contract and guards the Java prototype's flow.
 *
 * The CP is never connected (wsUrl points at a dead port), so an ocpp_absent
 * assertion for Reset is deterministically satisfied → verdict PASS, with no
 * live CSMS required.
 */
const CP_ID = "CP-HARNESS";
const CONNECTOR = 1;

const INLINE_SCENARIO = {
  id: "harness-pass-demo",
  name: "Harness PASS demo",
  targetType: "connector",
  targetId: 1,
  nodes: [
    {
      id: "start-1",
      type: "start",
      position: { x: 0, y: 0 },
      data: { label: "S" },
    },
    {
      id: "mv-1",
      type: "meterValue",
      position: { x: 0, y: 1 },
      data: { label: "MV", value: 100, sendMessage: false },
    },
    {
      id: "end-1",
      type: "end",
      position: { x: 0, y: 2 },
      data: { label: "E" },
    },
  ],
  edges: [
    { id: "e1", source: "start-1", target: "mv-1" },
    { id: "e2", source: "mv-1", target: "end-1" },
  ],
  assertions: [{ id: "no-reset", type: "ocpp_absent", action: "Reset" }],
};

const servers: TestServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(5_000).emitWithAck("rpc", request);
}

async function serverWithDb(): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "ocpp-harness-verdict-"));
  tempDirs.push(dir);
  const db = BunSqliteDatabase.open(join(dir, "state.db"));
  const server = await startTestServer({ database: db });
  servers.push(server);
  return server;
}

describe("issue #111: drive a scenario verdict over the Socket.IO control plane", () => {
  it("cp.create → load_scenario → run_scenario → scenario_report yields PASS", async () => {
    const server = await serverWithDb();
    const socket = await connectTestClient(server);
    const events: any[] = [];
    socket.on("event", (envelope: any) => events.push(envelope));

    try {
      // 1. Create a CP pointed at a dead port so it never connects to a CSMS.
      const created = await emitRpc(socket, {
        method: "cp.create",
        params: {
          cpId: CP_ID,
          wsUrl: "ws://127.0.0.1:65534/never",
          connectors: 1,
        },
      });
      expect(created.ok).toBe(true);

      // The registry lists it.
      const list = await emitRpc(socket, { method: "cp.list", params: {} });
      expect(list.ok).toBe(true);
      expect(list.result.some((cp: any) => cp.cpId === CP_ID)).toBe(true);

      // 2. Subscribe to this CP's events before running.
      const subscribed = await emitRpc(socket, {
        method: "events.subscribe",
        params: { scope: CP_ID },
      });
      expect(subscribed.ok).toBe(true);

      // 3. Load the inline scenario, then run it.
      const loaded = await emitRpc(socket, {
        cpId: CP_ID,
        method: "load_scenario",
        params: { connector: CONNECTOR, scenario: INLINE_SCENARIO },
      });
      expect(loaded.ok).toBe(true);
      const scenarioId: string =
        typeof loaded.result === "string" ? loaded.result : INLINE_SCENARIO.id;

      const ran = await emitRpc(socket, {
        cpId: CP_ID,
        method: "run_scenario",
        params: { connector: CONNECTOR, scenarioId },
      });
      expect(ran.ok).toBe(true);

      // 4. Poll the machine-readable report until the run has finished.
      // ~15s max at 200ms intervals, matching the Java awaitReport contract in
      // examples/testcontainers-java so both harnesses tolerate slow CI equally.
      let report: any = null;
      for (let i = 0; i < 75 && !report; i++) {
        const ack = await emitRpc(socket, {
          cpId: CP_ID,
          method: "scenario_report",
          params: { connector: CONNECTOR, scenarioId },
        });
        expect(ack.ok).toBe(true);
        if (ack.result && ack.result.verdict) {
          report = ack.result;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      // 5. Assert the verdict the way a CSMS certification IT would.
      expect(report).not.toBeNull();
      expect(report.schemaVersion).toBe(1);
      expect(report.verdict).toBe("PASS");
      expect(report.assertions).toHaveLength(1);
      expect(report.assertions[0]).toMatchObject({
        id: "no-reset",
        type: "ocpp_absent",
        status: "passed",
      });

      // The event stream carried the scenario lifecycle too.
      expect(events.some((e) => e.kind === "cp")).toBe(true);
    } finally {
      socket.disconnect();
    }
  });
});
