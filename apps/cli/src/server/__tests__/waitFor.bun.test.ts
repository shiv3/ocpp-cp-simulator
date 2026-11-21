/* eslint-disable @typescript-eslint/no-explicit-any -- test ack payloads */
// Runs under `bun test`: a real daemon driven over Socket.IO and JSON-Lines
// mode, against a mock CSMS.
import { afterEach, describe, expect, it } from "bun:test";

import { startServer, type RunningServer } from "../startServer";
import { connectTestClient } from "./socketHarness";
import {
  startMockCsms,
  type MockCsms,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/__tests__/mockCsms";
import { RemoteChargePointService } from "@ocpp-cp-simulator/client/remote/RemoteChargePointService";
import { handleJsonCommand } from "../../jsonMode";
import { completingScenario } from "../../__tests__/completingScenario";

/**
 * #1090 / #1091: `wait_for` and `wait_quiet` on every surface that reaches the
 * daemon, and the `scenario_state_changed` event they build on.
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

const CP = "CP-WAIT";

function answerCsms(csms: MockCsms): () => void {
  const answered = new Set<string>();
  const tick = setInterval(() => {
    for (const frame of csms.received) {
      const id = frame[1];
      if (frame[0] !== 2 || typeof id !== "string" || answered.has(id)) {
        continue;
      }
      answered.add(id);
      if (frame[2] === "BootNotification") {
        csms.replyCallResult(id, {
          status: "Accepted",
          currentTime: "2026-10-30T00:00:00.000Z",
          interval: 300,
        });
      } else {
        csms.replyCallResult(id, {});
      }
    }
  }, 5);
  return () => clearInterval(tick);
}

describe("wait_for / wait_quiet (#1090, #1091)", () => {
  const cleanups: Array<() => unknown> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function daemon() {
    const csms = startMockCsms();
    cleanups.push(() => csms.stop());
    cleanups.push(answerCsms(csms));
    const running: RunningServer = await startServer({
      ...BASE_OPTIONS,
      httpPort: 0,
    });
    cleanups.push(() => running.stop());
    const base = `http://127.0.0.1:${running.httpPort}`;
    const socket = await connectTestClient(base);
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
      cpId: CP,
      wsUrl: csms.url,
      connectors: 1,
      vendor: "V",
      model: "M",
      ocppVersion: "OCPP-1.6J",
    });
    expect(created.ok).toBe(true);
    return { rpc, base, csms };
  }

  it("wait_for an event resolves when it arrives, with its data", async () => {
    const { rpc } = await daemon();
    const waiting = rpc(
      "wait_for",
      { event: "boot_notification", match: { status: "Accepted" } },
      CP,
    );
    expect((await rpc("connect", {}, CP)).ok).toBe(true);
    const ack = await waiting;
    expect(ack.ok).toBe(true);
    expect(ack.result).toMatchObject({
      matched: true,
      timedOut: false,
      event: "boot_notification",
      data: { status: "Accepted", interval: 300 },
    });
  });

  it("a timeout is a result, and bad params are refused", async () => {
    const { rpc } = await daemon();
    const ack = await rpc(
      "wait_for",
      { event: "never_happens", timeoutMs: 50 },
      CP,
    );
    expect(ack.ok).toBe(true);
    expect(ack.result).toEqual({ matched: false, timedOut: true });

    for (const bad of [
      {},
      {
        event: "x",
        scenario: { connector: 1, scenarioId: "s", state: "idle" },
      },
      { match: { a: 1 } },
    ]) {
      const refused = await rpc("wait_for", bad, CP);
      expect(refused.ok).toBe(false);
      expect(refused.error.code).toBe("invalid_params");
    }
  });

  it("waits on a scenario state, now or later, and scenario_state_changed names the node", async () => {
    const { rpc, csms } = await daemon();
    expect((await rpc("connect", {}, CP)).ok).toBe(true);
    await csms.waitForCall("BootNotification");
    const scenario = completingScenario("wait-sc");
    expect(
      (await rpc("load_scenario", { connector: 1, scenario }, CP)).ok,
    ).toBe(true);
    const done = rpc(
      "wait_for",
      {
        scenario: { connector: 1, scenarioId: "wait-sc", state: "completed" },
        timeoutMs: 5000,
      },
      CP,
    );
    const sawNode = rpc(
      "wait_for",
      { event: "scenario_state_changed", match: { state: "running" } },
      CP,
    );
    expect(
      (await rpc("run_scenario", { connector: 1, scenarioId: "wait-sc" }, CP))
        .ok,
    ).toBe(true);
    const completed = await done;
    expect(completed.result.matched).toBe(true);
    const running = await sawNode;
    expect(running.result.data).toMatchObject({
      connectorId: 1,
      scenarioId: "wait-sc",
      state: "running",
    });
    // Already completed: answers at once from the status.
    const again = await rpc(
      "wait_for",
      {
        scenario: { connector: 1, scenarioId: "wait-sc", state: "completed" },
        timeoutMs: 5000,
      },
      CP,
    );
    expect(again.result).toMatchObject({ matched: true, timedOut: false });
  });

  it("wait_quiet resolves once the CALLs are answered and the wire is idle", async () => {
    const { rpc, csms } = await daemon();
    expect((await rpc("connect", {}, CP)).ok).toBe(true);
    await csms.waitForCall("BootNotification");
    const ack = await rpc("wait_quiet", { quietMs: 200, timeoutMs: 5000 }, CP);
    expect(ack.ok).toBe(true);
    expect(ack.result).toEqual({
      quiet: true,
      reason: "quiet",
      outstandingCalls: 0,
    });
  });

  it("wait_quiet reports a link that is down, and the remote service and JSON-Lines mode reach both", async () => {
    const { rpc, base } = await daemon();
    const offline = await rpc("wait_quiet", {}, CP);
    expect(offline.result).toEqual({
      quiet: false,
      reason: "offline",
      outstandingCalls: 0,
    });

    const remote = new RemoteChargePointService(base);
    cleanups.push(() => remote.dispose());
    const viaJson = (await handleJsonCommand(
      { chargePointService: remote, cpId: CP },
      { command: "wait_for", params: { event: "nothing", timeoutMs: 30 } },
    )) as { timedOut: boolean };
    expect(viaJson.timedOut).toBe(true);
    const quiet = (await handleJsonCommand(
      { chargePointService: remote, cpId: CP },
      { command: "wait_quiet", params: { timeoutMs: 100 } },
    )) as { reason: string };
    expect(quiet.reason).toBe("offline");
  });
});
