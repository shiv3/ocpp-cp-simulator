/* eslint-disable @typescript-eslint/no-explicit-any -- OCPP frames and ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";
import {
  startMockCsms,
  type MockCsms,
  type OcppFrame,
} from "../../../cp/infrastructure/transport/__tests__/mockCsms";
import type { CLIChargePointService } from "../../service";
import type { Connector } from "../../../cp/domain/connector/Connector";
import essentialCpBehavior from "../../../utils/scenarios/essential-cp-behavior.json";

/**
 * #367: "Essential CP Behavior" ran its first session correctly, but on the
 * next RemoteStart/RemoteStop cycle on the same connector the Auto MeterValue
 * node completed at once — no MeterValues, SoC stuck at its initial value, and
 * the run already parked on "Wait for RemoteStopTransaction".
 *
 * Cause: StopTransactionResultHandler cleared whatever transaction the
 * connector held when StopTransaction.conf arrived. ChargePoint.stopTransaction
 * has already cleared the stopped one when it sent the request, so a conf that
 * lands after the next session began tore down the *new* transaction: it
 * stopped the new session's auto-meter and resolved the Meter Value node's wait
 * on the spurious `transactionChange { transaction: null }`.
 *
 * This drives the shipped template's graph end to end over a real socket
 * against the mock CSMS, twice on the same charge point (no reconnect, no
 * re-create). Only the EV and meter numbers are scaled down so a session takes
 * seconds: a 1 kWh battery from 20 % to 80 % is a 600 Wh session target.
 */
const CONNECTOR = 1;
const SESSION_TARGET_WH = 600;

const scenario = (() => {
  const def = structuredClone(essentialCpBehavior) as any;
  def.id = "essential-cp-behavior-367";
  def.evSettings = { ...def.evSettings, batteryCapacityKwh: 1 };
  for (const node of def.nodes) {
    if (node.type === "delay") node.data.delaySeconds = 1;
    if (node.type === "meterValue") {
      node.data.incrementInterval = 1;
      node.data.incrementAmount = 200;
      delete node.data.outputKw;
    }
  }
  def.createdAt = "2026-09-29T00:00:00Z";
  def.updatedAt = "2026-09-29T00:00:00Z";
  return def;
})();

const servers: TestServer[] = [];
const csmsList: MockCsms[] = [];
const stoppers: Array<() => void> = [];

afterEach(async () => {
  while (stoppers.length > 0) stoppers.pop()?.();
  while (servers.length > 0) await servers.pop()?.close();
  while (csmsList.length > 0) await csmsList.pop()?.stop();
});

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(5_000).emitWithAck("rpc", request);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(
  what: string,
  probe: () => T | null | undefined | false,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Answers every CALL the charge point sends, the way a CSMS would. A
 * StopTransaction.req can be held back (`holdStopTransaction`) and answered
 * later with `releaseHeldStopTransactions`.
 */
function autoRespond(csms: MockCsms) {
  let cursor = 0;
  let nextTransactionId = 1001;
  const held: string[] = [];
  const state = { holdStopTransaction: false };
  const timer = setInterval(() => {
    for (; cursor < csms.received.length; cursor++) {
      const frame = csms.received[cursor] as OcppFrame;
      if (frame[0] !== 2) continue;
      const [, messageId, action] = frame as [number, string, string];
      switch (action) {
        case "BootNotification":
          csms.replyCallResult(messageId, {
            currentTime: new Date().toISOString(),
            interval: 300,
            status: "Accepted",
          });
          break;
        case "Heartbeat":
          csms.replyCallResult(messageId, {
            currentTime: new Date().toISOString(),
          });
          break;
        case "Authorize":
          csms.replyCallResult(messageId, {
            idTagInfo: { status: "Accepted" },
          });
          break;
        case "StartTransaction":
          csms.replyCallResult(messageId, {
            transactionId: nextTransactionId++,
            idTagInfo: { status: "Accepted" },
          });
          break;
        case "StopTransaction":
          if (state.holdStopTransaction) held.push(messageId);
          else
            csms.replyCallResult(messageId, {
              idTagInfo: { status: "Accepted" },
            });
          break;
        default:
          csms.replyCallResult(messageId, {});
      }
    }
  }, 5);
  stoppers.push(() => clearInterval(timer));
  return {
    state,
    held,
    releaseHeldStopTransactions() {
      while (held.length > 0) {
        csms.replyCallResult(held.shift()!, {
          idTagInfo: { status: "Accepted" },
        });
      }
    },
  };
}

function callsSince(csms: MockCsms, from: number, action: string): any[] {
  return csms.received
    .slice(from)
    .filter((f) => f[0] === 2 && f[2] === action)
    .map((f) => f[3]);
}

interface Session {
  meterStart: number;
  meterStop: number;
  meterValuesSent: number;
  socAtStart: number | null;
  socAtEnd: number | null;
  /** Current node sampled while the register was below the session target. */
  nodesBeforeTarget: Set<string | null>;
}

async function runTwoSessions(opts: {
  holdFirstStopConf: boolean;
}): Promise<[Session, Session]> {
  const csms = startMockCsms();
  csmsList.push(csms);
  const responder = autoRespond(csms);
  const server = await startTestServer();
  servers.push(server);
  const socket = await connectTestClient(server);
  const cpId = opts.holdFirstStopConf ? "CP367RACE" : "CP367";

  try {
    // Registry create with seedDefault:false so only the scenario under test
    // owns the connector's connect auto-start slot.
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
    const svc = server.registry.get(cpId) as CLIChargePointService;
    const connector = (
      svc as unknown as {
        _chargePoint: { getConnector(id: number): Connector };
      }
    )._chargePoint.getConnector(CONNECTOR);
    const status = () => svc.getScenarioStatus(CONNECTOR, scenario.id);

    const loaded = await emitRpc(socket, {
      cpId,
      method: "load_scenario",
      params: { connector: CONNECTOR, scenario },
    });
    expect(loaded.ok).toBe(true);

    // First run starts on connect (triggerOn: "connect").
    const connected = await emitRpc(socket, {
      cpId,
      method: "connect",
      params: {},
    });
    expect(connected.ok).toBe(true);

    const sessions: Session[] = [];
    for (let n = 1; n <= 2; n++) {
      if (n === 2) {
        await until("run 1 to complete", () => status()?.state === "completed");
        const ran = await emitRpc(socket, {
          cpId,
          method: "run_scenario",
          params: {
            connector: CONNECTOR,
            scenarioId: scenario.id,
            awaitArmed: true,
          },
        });
        expect(ran.ok).toBe(true);
      }

      await until(
        `run ${n} to wait for RemoteStart`,
        () => status()?.currentNodeId === "trigger-remote-start",
      );
      const from = csms.received.length;
      csms.send([
        2,
        `remote-start-${n}`,
        "RemoteStartTransaction",
        { connectorId: CONNECTOR, idTag: "TAG001" },
      ]);

      // The session has begun once the scenario is past its tx-start node.
      await until(
        `session ${n} to enter the Meter Value node`,
        () => status()?.currentNodeId === "meter-auto",
      );
      const meterStart = connector.transaction!.meterStart;
      const socAtStart = connector.soc;
      const target = meterStart + SESSION_TARGET_WH;

      if (n === 2 && opts.holdFirstStopConf) {
        // Session 1's StopTransaction.conf lands only now, after session 2
        // began on the same connector.
        responder.releaseHeldStopTransactions();
      }

      const nodesBeforeTarget = new Set<string | null>();
      await until(`session ${n} to reach its target (${target} Wh)`, () => {
        if (connector.meterValue >= target) return true;
        nodesBeforeTarget.add(status()?.currentNodeId ?? null);
        return false;
      });
      await until(
        `run ${n} to wait for RemoteStop`,
        () => status()?.currentNodeId === "trigger-remote-stop",
      );

      const transactionId = await until(
        `session ${n} transaction id`,
        () => connector.transaction?.id,
      );
      if (n === 1 && opts.holdFirstStopConf) {
        responder.state.holdStopTransaction = true;
      }
      csms.send([
        2,
        `remote-stop-${n}`,
        "RemoteStopTransaction",
        { transactionId },
      ]);
      const stop = await until(
        `session ${n} StopTransaction.req`,
        () => callsSince(csms, from, "StopTransaction")[0],
      );
      responder.state.holdStopTransaction = false;

      sessions.push({
        meterStart,
        meterStop: stop.meterStop,
        meterValuesSent: callsSince(csms, from, "MeterValues").length,
        socAtStart,
        socAtEnd: connector.soc,
        nodesBeforeTarget,
      });
    }
    return sessions as [Session, Session];
  } finally {
    socket.disconnect();
  }
}

function expectConsecutiveSessions([first, second]: [Session, Session]) {
  for (const session of [first, second]) {
    expect(session.meterValuesSent).toBeGreaterThan(0);
    expect(session.meterStop).toBe(session.meterStart + SESSION_TARGET_WH);
    expect(session.socAtStart).toBe(20);
    expect(session.socAtEnd).toBe(80);
    // The Meter Value node holds until the session's own target is reached.
    expect([...session.nodesBeforeTarget]).toEqual(["meter-auto"]);
  }
  // The second session starts from the cumulative register, and its target
  // is relative to that, not to the previous session's reading.
  expect(second.meterStart).toBe(first.meterStop);
  expect(second.meterStart + SESSION_TARGET_WH).toBeGreaterThan(
    second.meterStart,
  );
  expect(second.meterStop).toBeGreaterThan(second.meterStart);
}

describe("Essential CP Behavior over consecutive sessions on one connector (#367)", () => {
  it("meters both sessions when the CSMS answers promptly", async () => {
    expectConsecutiveSessions(
      await runTwoSessions({ holdFirstStopConf: false }),
    );
  }, 60_000);

  it("meters the second session when the first StopTransaction.conf arrives after it began", async () => {
    expectConsecutiveSessions(
      await runTwoSessions({ holdFirstStopConf: true }),
    );
  }, 60_000);
});
