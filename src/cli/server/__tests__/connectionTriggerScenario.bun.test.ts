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
 * #240 connectionTrigger over a real socket: a run started via run_scenario
 * parks on "wait disconnected", survives a disconnect/reconnect cycle,
 * parks on "wait connected", and finishes after the reconnect — as ONE run
 * (runId constant throughout). The same test pins the connector-wide
 * one-scenario-at-a-time gate in tryAutoStartForConnector
 * (service.ts:2161-2171): while scenario A's run is still live, the
 * reconnect's connect-auto-start must NOT re-run bystander scenario B.
 *
 * Why B has to be a real, separate connect-triggered scenario, loaded
 * FIRST: tryAutoStartForConnector iterates loaded scenarios in Map
 * insertion order, and once a candidate passes its trigger-shape filters
 * every outcome (start / blocked-by-active / blocked-by-dedup / caught
 * exception from runScenario) ends in an unconditional `return` — it never
 * falls through to try a later scenario. So whichever connect-triggered
 * scenario is loaded FIRST permanently shadows every later one for
 * auto-start purposes. B is loaded before A specifically so B — not A — is
 * that first (and only) auto-start candidate; A is started manually via
 * run_scenario and is otherwise inert as far as tryAutoStartForConnector is
 * concerned (Map-order shadowed, it's never even examined).
 *
 * That shadowing is what makes the final assertion discriminating: on the
 * reconnect's boot-accept, B is the candidate examined, its dedup key has
 * just been cleared by the disconnect's teardownAfterClose (so the dedup
 * `return` doesn't block it), and B itself isn't running (so runScenario's
 * own same-scenarioId reentrancy guard doesn't apply to B either) — the
 * ONLY thing standing between B and a second run is the active-loop at
 * 2161-2171 seeing A's still-live executor. A is deliberately held in a
 * `delay` node for ~300ms past the socket reopening, well past the
 * ~20-30ms BootNotification round trip, so it is still "active" at the
 * exact moment that check runs. Delete that loop and B gets a second runId
 * right here — a loud, specific failure, not a silently-swallowed one.
 *
 * This is the complement of scenarioRearmOnReconnect.bun.test.ts (#253):
 * that test proves a connect-triggered scenario DOES re-arm after a
 * reconnect when nothing else on the connector is running; this one proves
 * it does NOT when something else still is.
 *
 * Test history: see task-8-report.md (original task-8 brief, plus two
 * review fix rounds) for how this test's shape evolved and why.
 */
const CONNECTOR = 1;

const scenarioA = {
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
      // triggerOn is irrelevant to how A itself gets started here (it's
      // always started manually, via run_scenario) — spelled out anyway
      // since Map-order shadowing depends on A having the same trigger
      // shape B does, so A really would be a "connect" auto-start
      // candidate if B didn't shadow it.
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
 * A quick connect-triggered scenario, loaded BEFORE A so it — not A — is
 * the Map-insertion-order auto-start candidate (see header comment). Node
 * shape mirrors scenarioRearmOnReconnect.bun.test.ts's own scenario:
 * start -> statusChange "Preparing" -> end, nothing that waits.
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
        params: { connector: CONNECTOR, scenarioId: scenarioA.id },
      })
    ).result;
    if (status && predicate(status)) return status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for scenario state");
}

/** Poll scenario_report for `scenarioId` until a run whose id isn't
 *  `previousRunId` shows up (adapted from scenarioRearmOnReconnect's
 *  version, generalized to take the scenarioId explicitly since this file
 *  tracks two scenarios' runs). */
async function waitForRunAfter(
  socket: Socket,
  cpId: string,
  scenarioId: string,
  previousRunId: string | null,
  timeoutMs = 5_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const report = (
      await emitRpc(socket, {
        cpId,
        method: "scenario_report",
        params: { connector: CONNECTOR, scenarioId },
      })
    ).result;
    const runId = report?.runId ?? null;
    if (runId && runId !== previousRunId) return runId;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe("connectionTrigger scenario over a real socket (#240)", () => {
  it("survives a disconnect/reconnect as one run and blocks the cross-scenario auto-start re-arm", async () => {
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

      // B loaded FIRST: Map insertion order makes it the sole connect-
      // auto-start candidate (see header comment).
      expect(
        (
          await emitRpc(socket, {
            cpId,
            method: "load_scenario",
            params: { connector: CONNECTOR, scenario: scenarioB },
          })
        ).ok,
      ).toBe(true);
      // A loaded SECOND: Map-order shadowed, so it never auto-starts even
      // though its own Start node also opts into triggerOn "connect". A is
      // started manually below.
      expect(
        (
          await emitRpc(socket, {
            cpId,
            method: "load_scenario",
            params: { connector: CONNECTOR, scenario: scenarioA },
          })
        ).ok,
      ).toBe(true);

      // Connect → B is the only auto-start candidate → it runs to
      // completion immediately (no waits in its graph).
      await connectAndBoot(socket, cpId, csms);
      const bystanderRunId1 = await waitForRunAfter(
        socket,
        cpId,
        scenarioB.id,
        null,
      );
      expect(bystanderRunId1).not.toBeNull();

      // Start A manually — it would never get picked by auto-start while
      // B is loaded first.
      expect(
        (
          await emitRpc(socket, {
            cpId,
            method: "run_scenario",
            params: { connector: CONNECTOR, scenarioId: scenarioA.id },
          })
        ).ok,
      ).toBe(true);
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

      // Drop the socket: wait-down resolves, wait-up parks — same run.
      // teardownAfterClose also clears connector.lastAutoStartedScenarioKey
      // here, re-arming B's dedup key exactly as the #253 rearm test
      // expects for the idle case — this test complements it for the case
      // where something else (A) is still live.
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

      // Reconnect: the boot-accept re-fires connect-auto-start with B (not
      // A) as the sole Map-order candidate. B's dedup key was just
      // cleared, and B itself isn't running — the active-loop seeing A's
      // still-live executor (parked in the delay node) is the only thing
      // that can stop B from re-running here.
      await connectAndBoot(socket, cpId, csms);
      const completed = await waitForScenarioState(
        socket,
        cpId,
        (s) => s.state === "completed",
      );
      expect(completed.runId).toBe(runId);

      // Discriminating assertion: B is still on its first run. If
      // service.ts:2161-2171's active-loop were deleted, B would have
      // re-started on the reconnect's boot-accept and this would observe a
      // new runId.
      const bystanderReport = (
        await emitRpc(socket, {
          cpId,
          method: "scenario_report",
          params: { connector: CONNECTOR, scenarioId: scenarioB.id },
        })
      ).result;
      expect(bystanderReport?.runId).toBe(bystanderRunId1);
    } finally {
      socket.disconnect();
    }
  }, 30_000);
});
