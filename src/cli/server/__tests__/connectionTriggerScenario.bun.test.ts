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
 * #240 connectionTrigger over a real socket: a connect-started run parks on
 * "wait disconnected", survives the drop, parks on "wait connected", and
 * finishes after the reconnect — as ONE run. The same test pins the
 * reconnect auto-start skip (service.ts one-scenario-at-a-time): if the
 * re-arm restarted the scenario, the runId would change.
 *
 * Deviation from the task-8 brief: a bare `wait-up -> end` graph raced the
 * reconnect auto-start check and lost every time, deterministically, not
 * flakily. `ChargePoint.connect()` fires the "connected" event synchronously
 * off the raw WebSocket open, before BootNotification.req is even answered
 * (see ChargePoint.ts connect()) — so "wait connected" always resolves and
 * the run always reaches "end" (dropping out of `_executors`) well before
 * BootNotification.conf comes back and `handleConnectAutoStart` re-checks
 * the connector. By then `lastAutoStartedScenarioKey` has already been
 * cleared by the mid-run disconnect's `teardownAfterClose`, so nothing
 * blocks a second auto-start — this is the "reconnect auto-start SKIPPING
 * the still-live run" property the test exists to pin, and the literal
 * brief graph never lets the run still be live at the moment that matters.
 * A short `delay` node after "wait connected" keeps the executor in
 * `_executors` across that window, which is what actually exercises the
 * one-scenario-at-a-time gate. See task-8-report.md.
 *
 * Fix round 1: a lone scenario A can't tell the cross-scenario active-check
 * (service.ts:2161-2171) apart from `runScenario`'s own same-scenarioId
 * reentrancy guard (service.ts:1099-1101, thrown and silently swallowed by
 * the auto-start try/catch) — both inspect the same `_executors` entry for
 * A, so either alone would keep `completed.runId` pinned to the original
 * run. `scenarioB` is a second, distinct connect-triggered scenario loaded
 * on the same connector (after A, so A remains the auto-start candidate
 * that actually runs) purely as a bystander: it must never get a
 * `scenario_status` while A is still live, which is the part of this test
 * that actually depends on the connector-wide active-check rather than A's
 * own single-scenario reentrancy path. See task-8-report.md fix round 1.
 */
const CONNECTOR = 1;

const scenario = {
  id: "connection-trigger-scenario",
  name: "Survive a reconnect via connection waits",
  targetType: "connector",
  targetId: CONNECTOR,
  trigger: { type: "manual" },
  enabled: true,
  nodes: [
    {
      id: "start-1",
      type: "start",
      position: { x: 0, y: 0 },
      data: { label: "Start", triggerOn: "connect" },
    },
    {
      id: "wait-down",
      type: "connectionTrigger",
      position: { x: 0, y: 1 },
      data: { label: "Wait disconnect", event: "disconnected", timeout: 0 },
    },
    {
      id: "wait-up",
      type: "connectionTrigger",
      position: { x: 0, y: 2 },
      data: { label: "Wait reconnect", event: "connected", timeout: 0 },
    },
    {
      id: "hold-1",
      type: "delay",
      position: { x: 0, y: 3 },
      data: { label: "Hold past boot-accept", delaySeconds: 0.3 },
    },
    {
      id: "end-1",
      type: "end",
      position: { x: 0, y: 4 },
      data: { label: "End" },
    },
  ],
  edges: [
    { id: "e1", source: "start-1", target: "wait-down" },
    { id: "e2", source: "wait-down", target: "wait-up" },
    { id: "e3", source: "wait-up", target: "hold-1" },
    { id: "e4", source: "hold-1", target: "end-1" },
  ],
  createdAt: "2026-08-03T00:00:00Z",
  updatedAt: "2026-08-03T00:00:00Z",
};

/**
 * A second, unrelated connect-triggered scenario on the same connector.
 * Loaded after `scenario` so `scenario` remains the auto-start candidate
 * that actually runs; this one exists purely to prove nothing else on the
 * connector starts while `scenario`'s run is live — see fix round 1 in the
 * header comment above.
 */
const scenarioB = {
  id: "connection-trigger-bystander",
  name: "Bystander connect-triggered scenario",
  targetType: "connector",
  targetId: CONNECTOR,
  trigger: { type: "manual" },
  enabled: true,
  nodes: [
    {
      id: "b-start-1",
      type: "start",
      position: { x: 400, y: 0 },
      data: { label: "Start", triggerOn: "connect" },
    },
    {
      id: "b-sc-1",
      type: "statusChange",
      position: { x: 400, y: 1 },
      data: { label: "Preparing", status: "Preparing" },
    },
    {
      id: "b-end-1",
      type: "end",
      position: { x: 400, y: 2 },
      data: { label: "End" },
    },
  ],
  edges: [
    { id: "be1", source: "b-start-1", target: "b-sc-1" },
    { id: "be2", source: "b-sc-1", target: "b-end-1" },
  ],
  createdAt: "2026-08-03T00:00:00Z",
  updatedAt: "2026-08-03T00:00:00Z",
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

async function waitForScenarioState(
  socket: Socket,
  cpId: string,
  predicate: (status: any) => boolean,
  timeoutMs = 5_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = (
      await emitRpc(socket, {
        cpId,
        method: "scenario_status",
        params: { connector: CONNECTOR, scenarioId: scenario.id },
      })
    ).result;
    if (status && predicate(status)) return status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for scenario state");
}

/** Single, non-polling `scenario_status` snapshot — null means the
 *  scenario has never run (no live executor, no recorded terminal run). */
async function getScenarioStatusOnce(
  socket: Socket,
  cpId: string,
  scenarioId: string,
): Promise<any> {
  return (
    await emitRpc(socket, {
      cpId,
      method: "scenario_status",
      params: { connector: CONNECTOR, scenarioId },
    })
  ).result;
}

describe("connectionTrigger scenario over a real socket (#240)", () => {
  it("survives a disconnect/reconnect as one run and blocks the auto-start re-arm", async () => {
    const csms = startMockCsms();
    csmsList.push(csms);
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    const cpId = "CPCONNTRIG";

    try {
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
      // Loaded after `scenario` so `scenario` stays the auto-start
      // candidate that actually runs (see the header comment).
      expect(
        (
          await emitRpc(socket, {
            cpId,
            method: "load_scenario",
            params: { connector: CONNECTOR, scenario: scenarioB },
          })
        ).ok,
      ).toBe(true);

      // Connect → auto-start → park on "wait disconnected" (CP is
      // connected, so the level check does not pass it through).
      await connectAndBoot(socket, cpId, csms);
      const parkedDown = await waitForScenarioState(
        socket,
        cpId,
        (s) => s.state === "waiting" && s.currentNodeId === "wait-down",
      );
      expect(parkedDown.expectation).toMatchObject({
        type: "connection",
        event: "disconnected",
      });
      const runId = parkedDown.runId;
      expect(runId).toBeTruthy();
      // The bystander never got a look-in on the first connect either —
      // "one scenario per connector per trigger" picked `scenario`, not it.
      expect(
        await getScenarioStatusOnce(socket, cpId, scenarioB.id),
      ).toBeNull();

      // Drop the socket: wait-down resolves, wait-up parks — same run.
      expect(
        (await emitRpc(socket, { cpId, method: "disconnect", params: {} })).ok,
      ).toBe(true);
      const parkedUp = await waitForScenarioState(
        socket,
        cpId,
        (s) => s.state === "waiting" && s.currentNodeId === "wait-up",
      );
      expect(parkedUp.expectation).toMatchObject({
        type: "connection",
        event: "connected",
      });
      expect(parkedUp.runId).toBe(runId);

      // Reconnect: the run completes; the auto-start re-arm must NOT have
      // started a second run (runId unchanged all the way to completed).
      await connectAndBoot(socket, cpId, csms);
      const completed = await waitForScenarioState(
        socket,
        cpId,
        (s) => s.state === "completed",
      );
      expect(completed.runId).toBe(runId);
      // Across the whole disconnect/reconnect cycle — including the
      // reconnect's connect-auto-start re-check while `scenario` was still
      // live — the bystander never ran either.
      expect(
        await getScenarioStatusOnce(socket, cpId, scenarioB.id),
      ).toBeNull();
    } finally {
      socket.disconnect();
    }
  }, 30_000);
});
