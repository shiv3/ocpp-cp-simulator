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
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/__tests__/mockCsms";
import type { CLIChargePointService } from "../../service";

/**
 * The opt-in `stopTransactions` of `cp.delete` and `disconnect`: the running
 * transactions of that one charge point are stopped (1.6 StopTransaction,
 * 2.x TransactionEvent Ended) and answered before it is closed. Without the
 * param the charge point goes away with its transaction open and sends
 * nothing.
 */
const servers: TestServer[] = [];
const csmsList: MockCsms[] = [];
const stoppers: Array<() => void> = [];

afterEach(async () => {
  while (stoppers.length > 0) stoppers.pop()?.();
  while (servers.length > 0) await servers.pop()?.close();
  while (csmsList.length > 0) await csmsList.pop()?.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(10_000).emitWithAck("rpc", request);
}

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

/** Answers every CALL as a CSMS would, for 1.6 and 2.x. */
function autoRespond(
  csms: MockCsms,
  /** Calls left unanswered, as a CSMS that never answers them. */
  ignore: ReadonlySet<string> = new Set(),
) {
  let cursor = 0;
  let nextTransactionId = 501;
  const timer = setInterval(() => {
    for (; cursor < csms.received.length; cursor++) {
      const frame = csms.received[cursor] as OcppFrame;
      if (frame[0] !== 2) continue;
      const [, messageId, action, payload] = frame as [
        number,
        string,
        string,
        any,
      ];
      if (ignore.has(action)) continue;
      switch (action) {
        case "BootNotification":
          csms.replyCallResult(messageId, {
            currentTime: new Date().toISOString(),
            interval: 300,
            status: "Accepted",
          });
          break;
        case "StatusNotification":
          // The mock answers the 2.x shape itself.
          if (typeof payload?.connectorStatus !== "string") {
            csms.replyCallResult(messageId, {});
          }
          break;
        case "Authorize":
          csms.replyCallResult(
            messageId,
            payload?.idToken
              ? { idTokenInfo: { status: "Accepted" } }
              : { idTagInfo: { status: "Accepted" } },
          );
          break;
        case "StartTransaction":
          csms.replyCallResult(messageId, {
            transactionId: nextTransactionId++,
            idTagInfo: { status: "Accepted" },
          });
          break;
        default:
          csms.replyCallResult(messageId, {});
      }
    }
  }, 5);
  stoppers.push(() => clearInterval(timer));
}

const calls = (csms: MockCsms, action: string, from = 0): any[] =>
  csms.received
    .slice(from)
    .filter((f) => f[0] === 2 && f[2] === action)
    .map((f) => f[3]);

const ended = (csms: MockCsms, from = 0): any[] =>
  calls(csms, "TransactionEvent", from).filter((p) => p.eventType === "Ended");

/** A charge point with a running transaction on connector 1. */
async function withTransaction(
  ocppVersion: "OCPP-1.6J" | "OCPP-2.0.1",
  options: {
    ignore?: ReadonlySet<string>;
    stopTransactionsWaitMs?: number;
  } = {},
) {
  const csms = startMockCsms();
  csmsList.push(csms);
  autoRespond(csms, options.ignore);
  const server = await startTestServer({
    stopTransactionsWaitMs: options.stopTransactionsWaitMs,
  });
  servers.push(server);
  const socket = await connectTestClient(server);
  const cpId = `CPSTOP-${ocppVersion}-${servers.length}`;
  server.registry.create(
    {
      cpId,
      wsUrl: csms.url,
      connectors: 1,
      vendor: "test",
      model: "test",
      basicAuth: null,
      ocppVersion,
    },
    { seedDefault: false },
  );
  const svc = server.registry.get(cpId) as CLIChargePointService;
  expect(
    (await emitRpc(socket, { cpId, method: "connect", params: {} })).ok,
  ).toBe(true);
  await until(
    "boot",
    () => svc.isOnline() && calls(csms, "BootNotification").length > 0,
  );
  await sleep(100);
  const started = await emitRpc(socket, {
    cpId,
    method: "start_transaction",
    params: { connector: 1, tagId: "TAG1" },
  });
  expect(started.ok).toBe(true);
  await until("the transaction", () =>
    svc.openTransactionConnectorIds().includes(1)
      ? ocppVersion === "OCPP-1.6J"
        ? calls(csms, "StartTransaction").length > 0
        : calls(csms, "TransactionEvent").length > 0
      : false,
  );
  // Let the start's answer settle (1.6: the transactionId arrives with it).
  await sleep(200);
  return { csms, server, socket, cpId, svc };
}

describe("cp.delete / disconnect with stopTransactions", () => {
  it("1.6: cp.delete stops the transaction with reason Other first", async () => {
    const { csms, server, socket, cpId } = await withTransaction("OCPP-1.6J");
    const from = csms.received.length;
    const deleted = await emitRpc(socket, {
      method: "cp.delete",
      params: { cpId, stopTransactions: true },
    });
    expect(deleted.ok).toBe(true);
    const stops = calls(csms, "StopTransaction", from);
    expect(stops).toHaveLength(1);
    expect(stops[0].reason).toBe("Other");
    expect(stops[0].transactionId).toBe(501);
    expect(server.registry.get(cpId)).toBeUndefined();
  });

  it("2.0.1: disconnect ends the transaction with AbnormalCondition and the reason given", async () => {
    const { csms, socket, cpId, svc } = await withTransaction("OCPP-2.0.1");
    const from = csms.received.length;
    const result = await emitRpc(socket, {
      cpId,
      method: "disconnect",
      params: { stopTransactions: true, reason: "Local" },
    });
    expect(result.ok).toBe(true);
    const events = ended(csms, from);
    expect(events).toHaveLength(1);
    expect(events[0].triggerReason).toBe("AbnormalCondition");
    expect(events[0].transactionInfo.stoppedReason).toBe("Local");
    await until("offline", () => !svc.isOnline());
  });

  it("2.0.1: cp.delete defaults the stoppedReason to Other", async () => {
    const { csms, socket, cpId } = await withTransaction("OCPP-2.0.1");
    const from = csms.received.length;
    const deleted = await emitRpc(socket, {
      method: "cp.delete",
      params: { cpId, stopTransactions: true },
    });
    expect(deleted.ok).toBe(true);
    const events = ended(csms, from);
    expect(events).toHaveLength(1);
    expect(events[0].transactionInfo.stoppedReason).toBe("Other");
  });

  it("without the param, cp.delete and disconnect send no stop", async () => {
    const v16 = await withTransaction("OCPP-1.6J");
    let from = v16.csms.received.length;
    expect(
      (
        await emitRpc(v16.socket, {
          method: "cp.delete",
          params: { cpId: v16.cpId },
        })
      ).ok,
    ).toBe(true);
    await sleep(200);
    expect(calls(v16.csms, "StopTransaction", from)).toEqual([]);

    const v201 = await withTransaction("OCPP-2.0.1");
    from = v201.csms.received.length;
    expect(
      (
        await emitRpc(v201.socket, {
          cpId: v201.cpId,
          method: "disconnect",
          params: {},
        })
      ).ok,
    ).toBe(true);
    await sleep(200);
    expect(ended(v201.csms, from)).toEqual([]);
    expect(v201.svc.openTransactionConnectorIds()).toEqual([1]);
  });

  for (const method of ["cp.delete", "disconnect"] as const) {
    it(`${method} leaves alone a replacement made by a cp.update during the wait`, async () => {
      const { csms, server, socket, cpId, svc } = await withTransaction(
        "OCPP-1.6J",
        // The CSMS never answers the stop, so the wait runs its full length.
        { ignore: new Set(["StopTransaction"]), stopTransactionsWaitMs: 1500 },
      );
      const from = csms.received.length;
      const closing = emitRpc(
        socket,
        method === "cp.delete"
          ? { method, params: { cpId, stopTransactions: true } }
          : { cpId, method, params: { stopTransactions: true } },
      );
      await until(
        "the stop",
        () => calls(csms, "StopTransaction", from).length > 0,
      );
      // A cp.update of the same cpId lands while the close waits.
      const replacement = server.registry.update(svc.getInit());
      expect(replacement).not.toBe(svc);
      const result = await closing;
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("unavailable");
      expect(result.error.message).toContain("was replaced");
      expect(server.registry.get(cpId)).toBe(replacement);
      expect(replacement.openTransactionConnectorIds()).toEqual([]);
    });
  }
});
