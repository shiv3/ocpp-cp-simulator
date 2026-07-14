/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
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
import { startMockCsms } from "../../../cp/infrastructure/transport/__tests__/mockCsms";

/**
 * Issue #209: in Remote/Docker mode a web-console upload persists scenario
 * *definitions* (scenario.definitions.replace) but does NOT load them into the
 * daemon's runtime scenario map — which is what connect-auto-start reads. So a
 * connect-triggered scenario intermittently stays idle after "Connect".
 *
 * This drives the same RPC sequence the console uses (cp.create → definitions
 * replace → connect), boots the CP to Available via a mock CSMS, and checks
 * whether the scenario auto-starts.
 */
const CONNECTOR = 1;

const scenario = {
  id: "uploaded-connect-scenario",
  name: "Uploaded connect-triggered scenario",
  targetType: "connector",
  targetId: 1,
  trigger: { type: "manual" },
  enabled: true,
  nodes: [
    {
      id: "start-1",
      type: "start",
      position: { x: 0, y: 0 },
      data: { label: "Start" },
    },
    {
      id: "sc-1",
      type: "statusChange",
      position: { x: 0, y: 1 },
      data: { label: "Preparing", status: "Preparing" },
    },
    {
      id: "end-1",
      type: "end",
      position: { x: 0, y: 2 },
      data: { label: "End" },
    },
  ],
  edges: [
    { id: "e1", source: "start-1", target: "sc-1" },
    { id: "e2", source: "sc-1", target: "end-1" },
  ],
  createdAt: "2026-07-14T00:00:00Z",
  updatedAt: "2026-07-14T00:00:00Z",
};

const servers: TestServer[] = [];
const tempDirs: string[] = [];
const csmsList: ReturnType<typeof startMockCsms>[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (csmsList.length > 0) await csmsList.pop()?.stop();
  while (tempDirs.length > 0)
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(5_000).emitWithAck("rpc", request);
}

describe("issue #209: connect-auto-start after a web-console upload", () => {
  it("auto-starts a definitions-uploaded connect-triggered scenario after boot", async () => {
    const csms = startMockCsms();
    csmsList.push(csms);
    const dir = mkdtempSync(join(tmpdir(), "ocpp-209-"));
    tempDirs.push(dir);
    const db = BunSqliteDatabase.open(join(dir, "state.db"));
    const server = await startTestServer({ database: db });
    servers.push(server);
    const socket = await connectTestClient(server);
    const cpId = "CP209";

    try {
      // 1. Create the CP pointed at the mock CSMS.
      expect(
        (
          await emitRpc(socket, {
            method: "cp.create",
            params: { cpId, wsUrl: csms.url, connectors: 1 },
          })
        ).ok,
      ).toBe(true);

      // 2. Web-console upload: persist the scenario DEFINITION only (exactly
      //    what the editor's file-upload does — no explicit load_scenario).
      expect(
        (
          await emitRpc(socket, {
            method: "scenario.definitions.replace",
            params: { cpId, connectorId: CONNECTOR, definitions: [scenario] },
          })
        ).ok,
      ).toBe(true);

      // 3. Connect + accept BootNotification so the CP reaches Available.
      const connectAck = emitRpc(socket, {
        cpId,
        method: "connect",
        params: {},
      });
      const boot = await csms.waitForCall("BootNotification");
      csms.replyCallResult(boot.messageId, {
        currentTime: new Date(0).toISOString(),
        interval: 300,
        status: "Accepted",
      });
      await connectAck;

      // 4. Give connect-auto-start time to fire.
      await new Promise((r) => setTimeout(r, 400));

      // 5. Did the scenario auto-start? Report is non-null once a run finished;
      //    a running scenario shows a non-idle status.
      const report = (
        await emitRpc(socket, {
          cpId,
          method: "scenario_report",
          params: { connector: CONNECTOR, scenarioId: scenario.id },
        })
      ).result;
      const status = (
        await emitRpc(socket, {
          cpId,
          method: "scenario_status",
          params: { connector: CONNECTOR, scenarioId: scenario.id },
        })
      ).result;

      const started =
        (report && report.verdict) ||
        (status &&
          (status.running ||
            status.state === "running" ||
            status.state === "completed"));
      expect(started).toBeTruthy();
    } finally {
      socket.disconnect();
    }
  });
});
