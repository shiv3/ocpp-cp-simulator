/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";
import { startMockCsms } from "../../../cp/infrastructure/transport/__tests__/mockCsms";

/**
 * A `triggerOn: "connect"` scenario that was killed by a WebSocket drop must
 * come back on the next connect.
 *
 * Field report (v0.7.5, GKE dev): `essential-cp-behavior` bootstrapped over all
 * connectors and parked on its remoteStartTrigger node died on a network-sim
 * manual-disconnect with "Disconnected while waiting for remote start". The CP
 * reconnected and BootNotification was accepted, but no scenario restarted --
 * so the simulator stopped answering RemoteStartTransaction entirely until an
 * operator re-fired run_scenario_template on every connector by hand.
 *
 * Cause: `tryAutoStartForConnector` dedups on
 * `Connector.lastAutoStartedScenarioKey`, which used to survive the
 * disconnect, so the post-reconnect `Available` looked like a scenario that was
 * already up. `ChargePoint.teardownAfterClose` now clears the arm.
 *
 * This drives the real thing end to end -- mock CSMS, boot, disconnect,
 * reconnect, boot -- and asserts a second run happened by watching
 * scenario_report's runId change.
 */
const CONNECTOR = 1;

const scenario = {
  id: "rearm-connect-scenario",
  name: "Connect-triggered scenario that must re-arm",
  targetType: "connector",
  targetId: CONNECTOR,
  trigger: { type: "manual" },
  enabled: true,
  nodes: [
    {
      id: "start-1",
      type: "start",
      position: { x: 0, y: 0 },
      // triggerOn defaults to "connect"; spelled out because it is the
      // behaviour under test.
      data: { label: "Start", triggerOn: "connect" },
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
 * Connect and answer the BootNotification so the CP reaches Available.
 *
 * mockCsms.waitForCall resolves against frames it has ALREADY received, so on
 * the second connect it would hand back the first boot's messageId and we'd
 * answer a dead request. Watch for a boot frame past the ones already seen.
 */
async function connectAndBoot(
  socket: Socket,
  cpId: string,
  csms: ReturnType<typeof startMockCsms>,
): Promise<void> {
  const seenBefore = csms.received.length;
  const connectAck = emitRpc(socket, { cpId, method: "connect", params: {} });

  const deadline = Date.now() + 5_000;
  let boot: { messageId: string } | null = null;
  while (Date.now() < deadline && !boot) {
    const frame = csms.received
      .slice(seenBefore)
      .find((f) => f[0] === 2 && f[2] === "BootNotification");
    if (frame) boot = { messageId: frame[1] as string };
    else await new Promise((r) => setTimeout(r, 20));
  }
  if (!boot) throw new Error("no new BootNotification after connect");

  csms.replyCallResult(boot.messageId, {
    currentTime: new Date(0).toISOString(),
    interval: 300,
    status: "Accepted",
  });
  await connectAck;
}

/** Poll scenario_report until a run whose id isn't `previousRunId` shows up. */
async function waitForRunAfter(
  socket: Socket,
  cpId: string,
  previousRunId: string | null,
  timeoutMs = 5_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const report = (
      await emitRpc(socket, {
        cpId,
        method: "scenario_report",
        params: { connector: CONNECTOR, scenarioId: scenario.id },
      })
    ).result;
    const runId = report?.runId ?? null;
    if (runId && runId !== previousRunId) return runId;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe("connect-triggered scenario re-arms after a reconnect", () => {
  // Two full connect+boot+run cycles over a real socket; the default 5s
  // budget is not enough.
  it("runs again once the CP reconnects and boots", async () => {
    const csms = startMockCsms();
    csmsList.push(csms);
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    const cpId = "CPREARM";

    try {
      // Created through the registry rather than cp.create so the default
      // `essential-cp-behavior` seed is skipped: it parks on its own
      // remoteStartTrigger node, and tryAutoStartForConnector allows only one
      // scenario per connector, so the seed would mask the scenario under test.
      server.registry.create(
        {
          cpId,
          wsUrl: csms.url,
          connectors: 1,
          vendor: "test",
          model: "test",
          basicAuth: null,
        },
        { seedDefault: false },
      );

      expect(
        (
          await emitRpc(socket, {
            cpId,
            method: "load_scenario",
            params: { connector: CONNECTOR, scenario },
          })
        ).ok,
      ).toBe(true);

      // First connect: the scenario auto-starts and finishes.
      await connectAndBoot(socket, cpId, csms);
      const firstRunId = await waitForRunAfter(socket, cpId, null);
      expect(firstRunId).not.toBeNull();

      // Drop the socket the way the field repro did, then come back up.
      expect(
        (await emitRpc(socket, { cpId, method: "disconnect", params: {} })).ok,
      ).toBe(true);
      await connectAndBoot(socket, cpId, csms);

      // The regression: this used to stay on firstRunId forever.
      const secondRunId = await waitForRunAfter(socket, cpId, firstRunId);
      expect(secondRunId).not.toBeNull();
      expect(secondRunId).not.toBe(firstRunId);
    } finally {
      socket.disconnect();
    }
  }, 30_000);
});
