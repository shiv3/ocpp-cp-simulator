/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";
import { startMockCsms } from "../../../cp/infrastructure/transport/__tests__/mockCsms";

/**
 * Clearing the connect-trigger arm on disconnect has to reach the DB, not just
 * memory.
 *
 * `ChargePoint.teardownAfterClose` clears every connector's
 * `lastAutoStartedScenarioKey`, and the `status = Unavailable` cascade right
 * after it is what normally emits the connector statusChange that drives
 * `persistConnectorRuntime`. But that cascade deliberately SKIPS a connector
 * mid-transaction (so a restart doesn't resurrect a transaction inside an
 * Unavailable shell) — so exactly the connectors that were charging when the
 * socket dropped never persisted the cleared arm, and a daemon restart restored
 * the stale one from `connector_runtime.last_auto_started_scenario_key`.
 *
 * That matters for any scenario whose id is stable across restarts (anything
 * loaded by id, or rehydrated by `restoreScenariosFromDatabase`): the arm key
 * embeds the scenario id, so a restored stale key means the connect-triggered
 * scenario never re-arms after the restart — the same silent failure, reached
 * through the restart path instead of the reconnect path.
 *
 * Caught by CodeRabbit on #253.
 */
const CONNECTOR = 1;
const CP_ID = "CPARMPERSIST";
const TRANSACTION_ID = 4242;

/** start → StartTransaction → long delay: the run stays alive holding an open
 *  transaction, which is the state that skips the Unavailable cascade. */
const scenario = {
  id: "arm-persist-scenario",
  name: "Charging when the socket drops",
  targetType: "connector",
  targetId: CONNECTOR,
  trigger: { type: "manual" },
  enabled: true,
  nodes: [
    {
      id: "s",
      type: "start",
      position: { x: 0, y: 0 },
      data: { label: "S", triggerOn: "connect" },
    },
    {
      id: "tx",
      type: "transaction",
      position: { x: 0, y: 1 },
      data: { label: "Start tx", action: "start", tagId: "TAG-ARM" },
    },
    {
      id: "hold",
      type: "delay",
      position: { x: 0, y: 2 },
      data: { label: "hold", delaySeconds: 600 },
    },
    { id: "e", type: "end", position: { x: 0, y: 3 }, data: { label: "E" } },
  ],
  edges: [
    { id: "e1", source: "s", target: "tx" },
    { id: "e2", source: "tx", target: "hold" },
    { id: "e3", source: "hold", target: "e" },
  ],
  createdAt: "2026-07-30T00:00:00Z",
  updatedAt: "2026-07-30T00:00:00Z",
};

const servers: TestServer[] = [];
const csmsList: ReturnType<typeof startMockCsms>[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (csmsList.length > 0) await csmsList.pop()?.stop();
});

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(5_000).emitWithAck("rpc", request);
}

/**
 * Answer every CALL the charge point sends, as it arrives.
 *
 * The §4.1.1 serializer sends one CALL at a time and waits for its CALLRESULT,
 * so leaving any of them unanswered — a StatusNotification, say — stalls
 * everything queued behind it, and the scenario never reaches its transaction
 * node. Answering selectively by action does not work here for that reason.
 */
function autoRespond(csms: ReturnType<typeof startMockCsms>): () => void {
  let next = 0;
  let stopped = false;

  const conf = (action: string): unknown => {
    switch (action) {
      case "BootNotification":
        return {
          currentTime: new Date(0).toISOString(),
          interval: 300,
          status: "Accepted",
        };
      case "Authorize":
        return { idTagInfo: { status: "Accepted" } };
      case "StartTransaction":
        return {
          transactionId: TRANSACTION_ID,
          idTagInfo: { status: "Accepted" },
        };
      case "Heartbeat":
        return { currentTime: new Date(0).toISOString() };
      default:
        // StatusNotification, MeterValues, StopTransaction: empty conf.
        return {};
    }
  };

  void (async () => {
    while (!stopped) {
      while (next < csms.received.length) {
        const frame = csms.received[next++];
        if (frame[0] !== 2) continue;
        csms.replyCallResult(frame[1] as string, conf(String(frame[2])));
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  })();

  return () => {
    stopped = true;
  };
}

describe("the cleared connect-trigger arm is persisted for a charging connector", () => {
  it("writes a null arm key even though the Unavailable cascade skips the connector", async () => {
    const csms = startMockCsms();
    csmsList.push(csms);
    const db = BunSqliteDatabase.open(":memory:");
    const server = await startTestServer({ database: db });
    servers.push(server);
    const socket = await connectTestClient(server);
    const stopResponder = autoRespond(csms);

    try {
      server.registry.create(
        {
          cpId: CP_ID,
          wsUrl: csms.url,
          connectors: 1,
          vendor: "test",
          model: "test",
          basicAuth: null,
        },
        { seedDefault: false },
      );

      await emitRpc(socket, {
        cpId: CP_ID,
        method: "load_scenario",
        params: { connector: CONNECTOR, scenario },
      });

      // Connect; the scenario auto-starts on Available and opens a transaction
      // (via Authorize, which a local start is gated on — issue #181), which is
      // what sets the arm key we care about.
      await emitRpc(socket, { cpId: CP_ID, method: "connect", params: {} });

      // Wait for the transaction to land on the connector.
      let hasTransaction = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !hasTransaction) {
        const status = (
          await emitRpc(socket, { cpId: CP_ID, method: "status", params: {} })
        ).result;
        hasTransaction =
          status?.connectors?.[0]?.transactionId === TRANSACTION_ID;
        if (!hasTransaction) await new Promise((r) => setTimeout(r, 50));
      }
      expect(hasTransaction).toBe(true);

      const armedRow = db.all<{
        last_auto_started_scenario_key: string | null;
      }>(
        "SELECT last_auto_started_scenario_key FROM connector_runtime WHERE cp_id = ? AND connector_id = ?",
        [CP_ID, CONNECTOR],
      );
      // Pre-condition: the arm really was persisted while running, otherwise
      // the assertion below would pass for the wrong reason.
      expect(armedRow[0]?.last_auto_started_scenario_key).toContain(
        scenario.id,
      );

      await emitRpc(socket, { cpId: CP_ID, method: "disconnect", params: {} });

      // The disconnect path is asynchronous, so wait on the condition rather
      // than a fixed sleep — a slow runner would otherwise read the row before
      // the write lands and fail for the wrong reason. Bounded, so a genuine
      // regression still fails instead of hanging.
      const readRow = () =>
        db.all<{
          status: string;
          transaction_json: string | null;
          last_auto_started_scenario_key: string | null;
        }>(
          "SELECT status, transaction_json, last_auto_started_scenario_key FROM connector_runtime WHERE cp_id = ? AND connector_id = ?",
          [CP_ID, CONNECTOR],
        );

      const persistDeadline = Date.now() + 10_000;
      while (Date.now() < persistDeadline) {
        if (readRow()[0]?.last_auto_started_scenario_key === null) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      const rows = readRow();
      expect(rows).toHaveLength(1);

      // Pin the branch under test: the connector kept its charging status and
      // its transaction, i.e. the Unavailable cascade skipped it. If this ever
      // changes, the test is no longer covering the reported gap.
      expect(rows[0].status).not.toBe("Unavailable");
      expect(rows[0].transaction_json).not.toBeNull();

      // The regression: this used to keep the pre-disconnect arm, so a restart
      // rehydrated it and the scenario never re-armed.
      expect(rows[0].last_auto_started_scenario_key).toBeNull();
    } finally {
      stopResponder();
      socket.disconnect();
    }
  }, 30_000);
});
