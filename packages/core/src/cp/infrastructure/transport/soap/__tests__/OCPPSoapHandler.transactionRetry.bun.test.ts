import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import type { ChargePointEvents } from "../../../../domain/charge-point/ChargePointEvents";
import type { Transaction } from "../../../../domain/connector/Transaction";
import { OCPPStatus } from "../../../../domain/types/OcppTypes";
import { Logger, LogLevel } from "../../../../shared/Logger";
import { VirtualClock } from "../../../../shared/clock";
import { OCPP15_DIALECT, OCPP16_DIALECT } from "../dialect";
import { OCPPSoapHandler } from "../OCPPSoapHandler";
import {
  buildSoapEnvelope,
  buildSoapFaultEnvelope,
  parseSoapEnvelope,
  type SoapOperation,
  type SoapPayload,
} from "../soapEnvelope";

/**
 * #585, OCPP-S 1.6 errata 3.2: a transaction-related message a SOAP Fault or
 * an HTTP error status answered is sent again (a couple of times, at
 * `TransactionMessageRetryInterval` x the transmissions so far), then
 * discarded with a notice. A Heartbeat tells a failure to process from a
 * connection issue. Driven by a virtual clock and a scripted fetch.
 */

type Reply = "ok" | "fault" | "http500" | "network";

const CS_URL = "http://csms.example/CentralSystemService";

function okPayload(operation: SoapOperation): SoapPayload {
  switch (operation) {
    case "Heartbeat":
      return { currentTime: "2026-06-30T00:00:05Z" };
    case "StartTransaction":
      return { transactionId: 101, idTagInfo: { status: "Accepted" } };
    default:
      return {};
  }
}

class ScriptedCentralSystem {
  posts: SoapOperation[] = [];
  /** Per operation, the replies in order; the last one repeats. */
  script: Partial<Record<SoapOperation, Reply[]>> = {};
  private readonly original = globalThis.fetch;
  private counts = new Map<SoapOperation, number>();

  start(): void {
    this.posts = [];
    this.counts = new Map();
    this.script = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      const parsed = parseSoapEnvelope(body, OCPP16_DIALECT);
      const operation = parsed.operation;
      this.posts.push(operation);
      const n = this.counts.get(operation) ?? 0;
      this.counts.set(operation, n + 1);
      const replies = this.script[operation] ?? ["ok"];
      const reply = replies[Math.min(n, replies.length - 1)];
      if (reply === "network") throw new TypeError("connection refused");
      if (reply === "fault") {
        return new Response(
          buildSoapFaultEnvelope({ reason: "boom", code: "Receiver" }),
          {
            status: 500,
            headers: { "content-type": "application/soap+xml" },
          },
        );
      }
      if (reply === "http500") {
        return new Response("<html>Internal Server Error</html>", {
          status: 500,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(
        buildSoapEnvelope({
          operation,
          kind: "response",
          chargeBoxIdentity: "CP-585",
          messageId: `uuid:conf-${this.posts.length}`,
          relatesTo: parsed.messageId,
          from: "http://anonymous",
          to: "http://anonymous",
          payload: okPayload(operation),
          dialect: OCPP16_DIALECT,
        }),
        { headers: { "content-type": "application/soap+xml" } },
      );
    }) as unknown as typeof fetch;
  }

  stop(): void {
    globalThis.fetch = this.original;
  }

  count(operation: SoapOperation): number {
    return this.posts.filter((p) => p === operation).length;
  }
}

function transaction(): Transaction {
  return {
    id: 0,
    connectorId: 1,
    tagId: "TAG-585",
    meterStart: 0,
    meterStop: null,
    startTime: new Date("2026-10-30T10:00:00.000Z"),
    stopTime: null,
    meterSent: false,
  } as Transaction;
}

function setup(
  config: { attempts?: number; interval?: number } = {},
  dialect = OCPP16_DIALECT,
) {
  const clock = new VirtualClock();
  const connector = {
    id: 1,
    status: OCPPStatus.Preparing,
    transaction: transaction() as Transaction | null,
    transactionId: undefined as number | undefined,
    meterValue: 1000,
    soc: null,
    evSettings: undefined,
    scheduleConstraints: () => ({ watts: Infinity, activePhases: 1 }),
    assignTransactionId(id: number) {
      this.transactionId = id;
    },
    markStartCallError() {
      if (this.transaction) this.transaction.startCallError = true;
    },
  };
  const rejected: Array<ChargePointEvents["transactionMessageRejected"]> = [];
  const hooks: { onRejected?: () => void } = {};
  const settings = { attempts: config.attempts ?? 3 };
  const discarded: Array<ChargePointEvents["transactionMessageDiscarded"]> = [];
  const chargePoint = {
    id: "CP-585",
    clock,
    database: null,
    connectors: new Map([[1, connector]]),
    getConnector: () => connector,
    notifyOutgoingCall: () => undefined,
    recordAuthorizationResult: () => undefined,
    signedMeterFor: () => null,
    updateConnectorStatus: (_id: number, status: OCPPStatus) => {
      connector.status = status;
    },
    cleanTransaction: () => undefined,
    notifyTransactionMessageRejected: (
      e: ChargePointEvents["transactionMessageRejected"],
    ) => {
      rejected.push(e);
      hooks.onRejected?.();
    },
    notifyTransactionMessageDiscarded: (
      e: ChargePointEvents["transactionMessageDiscarded"],
    ) => discarded.push(e),
    configuration: {
      transactionMessageAttempts: () => settings.attempts,
      transactionMessageRetryInterval: () => config.interval ?? 60,
      meterValuesSampledData: () => ["Energy.Active.Import.Register"],
    },
  };
  const handler = new OCPPSoapHandler(
    chargePoint as unknown as ChargePoint,
    new Logger(LogLevel.ERROR),
    { centralSystemUrl: CS_URL, dialect },
  );
  handler.setBootStatus({ status: "Accepted" });
  return { clock, connector, handler, rejected, discarded, hooks, settings };
}

/** Lets the request chain and its fetches settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

const csms = new ScriptedCentralSystem();
beforeEach(() => csms.start());
afterEach(() => csms.stop());

function start(handler: OCPPSoapHandler, tx: Transaction): void {
  handler.sendTransactionEvent({
    phase: "started",
    transaction: tx,
    connectorId: 1,
  });
}

describe("OCPP-S 1.6 transaction message retry (#585, errata 3.2)", () => {
  it("resends StartTransaction after a Fault, interval x1 then x2, and applies the conf", async () => {
    csms.script = { StartTransaction: ["fault", "http500", "ok"] };
    const { clock, connector, handler, rejected, discarded } = setup();
    start(handler, connector.transaction!);
    await settle();
    expect(csms.count("StartTransaction")).toBe(1);
    // The Heartbeat probe told a failure to process from a connection issue.
    expect(csms.count("Heartbeat")).toBe(1);
    expect(rejected.map((r) => [r.action, r.attempt, r.errorCode])).toEqual([
      ["StartTransaction", 1, "SOAP Fault Receiver"],
    ]);
    expect(connector.transaction!.startCallError).toBe(true);

    await clock.advanceBy(59_000);
    await settle();
    expect(csms.count("StartTransaction")).toBe(1);
    await clock.advanceBy(1_000);
    await settle();
    expect(csms.count("StartTransaction")).toBe(2);

    // Second failure (an HTTP error status): waits 2 x 60 s.
    expect(rejected.map((r) => [r.attempt, r.errorCode])).toEqual([
      [1, "SOAP Fault Receiver"],
      [2, "HTTP 500"],
    ]);
    await clock.advanceBy(119_000);
    await settle();
    expect(csms.count("StartTransaction")).toBe(2);
    await clock.advanceBy(1_000);
    await settle();
    expect(csms.count("StartTransaction")).toBe(3);

    expect(connector.transactionId).toBe(101);
    expect(discarded).toEqual([]);
    expect(clock.pending).toBe(0);
  });

  it("discards the message after TransactionMessageAttempts failures, with a notice", async () => {
    csms.script = { StopTransaction: ["fault"] };
    const { clock, connector, handler, rejected, discarded } = setup({
      attempts: 2,
    });
    const tx = connector.transaction!;
    tx.id = 101;
    tx.meterStop = 5;
    tx.stopTime = new Date("2026-10-30T11:00:00.000Z");
    handler.sendTransactionEvent({
      phase: "ended",
      transaction: tx,
      connectorId: 1,
    });
    await settle();
    await clock.advanceBy(60_000);
    await settle();
    expect(csms.count("StopTransaction")).toBe(2);
    expect(rejected.map((r) => r.attempt)).toEqual([1, 2]);
    expect(discarded).toEqual([
      {
        connectorId: 1,
        transactionId: "101",
        action: "StopTransaction",
        reason: "callError",
        errorCode: "SOAP Fault Receiver",
        attempts: 2,
      },
    ]);
    await clock.advanceBy(600_000);
    await settle();
    expect(csms.count("StopTransaction")).toBe(2);
    expect(clock.pending).toBe(0);
  });

  it("retries a MeterValues of a transaction but not one without", async () => {
    csms.script = { MeterValues: ["ok", "fault", "ok"] };
    const { clock, handler, rejected, discarded } = setup({ interval: 5 });
    handler.sendMeterValue(undefined, 1);
    await settle();
    expect(csms.count("MeterValues")).toBe(1);
    expect(csms.count("Heartbeat")).toBe(0);
    expect(rejected).toEqual([]);

    handler.sendMeterValue(101, 1);
    await settle();
    expect(csms.count("MeterValues")).toBe(2);
    expect(rejected.map((r) => [r.action, r.transactionId, r.attempt])).toEqual(
      [["MeterValues", "101", 1]],
    );
    await clock.advanceBy(5_000);
    await settle();
    expect(csms.count("MeterValues")).toBe(3);
    expect(discarded).toEqual([]);
  });

  it("discards a StartTransaction resend whose transaction no longer runs", async () => {
    csms.script = { StartTransaction: ["fault"] };
    const { clock, connector, handler, rejected, discarded } = setup();
    start(handler, connector.transaction!);
    await settle();
    expect(rejected).toHaveLength(1);

    // The transaction is stopped while the resend waits.
    connector.transaction!.stopTime = new Date("2026-10-30T10:30:00.000Z");
    await clock.advanceBy(60_000);
    await settle();
    expect(csms.count("StartTransaction")).toBe(1);
    expect(discarded).toEqual([
      expect.objectContaining({
        action: "StartTransaction",
        transactionId: "0",
        attempts: 1,
      }),
    ]);
  });

  it("discards at once a StartTransaction answered with a Fault after its transaction stopped", async () => {
    csms.script = { StartTransaction: ["fault"] };
    const { clock, connector, handler, rejected, discarded } = setup();
    const tx = connector.transaction!;
    tx.stopTime = new Date("2026-10-30T10:30:00.000Z");
    handler.sendTransactionEvent({
      phase: "started",
      transaction: tx,
      connectorId: 1,
    });
    await settle();
    expect(rejected).toHaveLength(1);
    expect(discarded).toHaveLength(1);
    expect(clock.pending).toBe(0);
  });

  it("lets a Preparing connector go on to Charging when the StartTransaction is discarded", async () => {
    csms.script = { StartTransaction: ["fault"] };
    const { clock, connector, handler, discarded } = setup({ attempts: 2 });
    start(handler, connector.transaction!);
    await settle();
    await clock.advanceBy(60_000);
    await settle();
    expect(discarded).toHaveLength(1);
    expect(connector.status).toBe(OCPPStatus.Charging);
  });

  it("does not retry when the Heartbeat probe fails: a connection issue", async () => {
    csms.script = { StartTransaction: ["fault"], Heartbeat: ["network"] };
    const { clock, connector, handler, rejected, discarded } = setup();
    start(handler, connector.transaction!);
    await settle();
    expect(csms.count("Heartbeat")).toBe(1);
    expect(rejected).toEqual([]);
    expect(discarded).toEqual([]);
    expect(clock.pending).toBe(0);
  });

  it("does not retry a network failure of the message itself", async () => {
    csms.script = { StartTransaction: ["network"] };
    const { clock, connector, handler, rejected } = setup();
    start(handler, connector.transaction!);
    await settle();
    expect(csms.count("Heartbeat")).toBe(0);
    expect(rejected).toEqual([]);
    expect(clock.pending).toBe(0);
  });

  it("cancels a waiting resend on stop, with a notice", async () => {
    csms.script = { StartTransaction: ["fault"] };
    const { clock, connector, handler, discarded } = setup();
    start(handler, connector.transaction!);
    await settle();
    expect(clock.pending).toBe(1);

    handler.onWebSocketClosed();
    expect(clock.pending).toBe(0);
    expect(discarded).toEqual([
      expect.objectContaining({ action: "StartTransaction", attempts: 1 }),
    ]);
    await clock.advanceBy(600_000);
    await settle();
    expect(csms.count("StartTransaction")).toBe(1);
    // The stop is not a go-ahead: the connector stays Preparing, and nothing
    // (a StatusNotification) is posted after the close.
    expect(connector.status).toBe(OCPPStatus.Preparing);
    expect(csms.posts).toEqual(["StartTransaction", "Heartbeat"]);
  });

  it("finds the timer when a rejected listener stops the CP", async () => {
    csms.script = { StartTransaction: ["fault"] };
    const { clock, connector, handler, hooks } = setup();
    hooks.onRejected = () => handler.onWebSocketClosed();
    start(handler, connector.transaction!);
    await settle();
    await clock.advanceBy(600_000);
    await settle();
    expect(csms.count("StartTransaction")).toBe(1);
    expect(clock.pending).toBe(0);
  });

  it("sends no Heartbeat for a Fault that lands after a stop, and notices the discard", async () => {
    csms.script = { StartTransaction: ["fault"] };
    const { clock, connector, handler, discarded } = setup();
    start(handler, connector.transaction!);
    handler.onWebSocketClosed();
    await settle();
    expect(csms.posts).toEqual(["StartTransaction"]);
    expect(discarded).toEqual([
      expect.objectContaining({ action: "StartTransaction", attempts: 1 }),
    ]);
    expect(connector.status).toBe(OCPPStatus.Preparing);
    expect(clock.pending).toBe(0);
  });

  it("discards a resend that falls due while the boot gate is closed", async () => {
    csms.script = { StartTransaction: ["fault"] };
    const { clock, connector, handler, discarded } = setup();
    start(handler, connector.transaction!);
    await settle();
    handler.setBootStatus({ status: "Pending" });
    await clock.advanceBy(60_000);
    await settle();
    expect(csms.count("StartTransaction")).toBe(1);
    expect(discarded).toEqual([
      expect.objectContaining({ action: "StartTransaction", attempts: 1 }),
    ]);
  });

  it("discards a waiting resend when TransactionMessageAttempts is lowered", async () => {
    csms.script = { StartTransaction: ["fault"] };
    const { clock, connector, handler, discarded, settings } = setup();
    start(handler, connector.transaction!);
    await settle();
    settings.attempts = 1;
    await clock.advanceBy(60_000);
    await settle();
    expect(csms.count("StartTransaction")).toBe(1);
    expect(discarded).toEqual([
      expect.objectContaining({ action: "StartTransaction", attempts: 1 }),
    ]);
  });

  it("follows a MeterValues discard end to end", async () => {
    csms.script = { MeterValues: ["fault"] };
    const { clock, handler, rejected, discarded } = setup({
      attempts: 2,
      interval: 5,
    });
    handler.sendMeterValue(101, 1);
    await settle();
    await clock.advanceBy(5_000);
    await settle();
    expect(csms.count("MeterValues")).toBe(2);
    expect(rejected.map((r) => r.attempt)).toEqual([1, 2]);
    expect(discarded).toEqual([
      expect.objectContaining({ action: "MeterValues", attempts: 2 }),
    ]);
    expect(clock.pending).toBe(0);
  });

  it("schedules nothing when a stop lands during the probe", async () => {
    csms.script = { StartTransaction: ["fault"] };
    const { clock, connector, handler, rejected } = setup();
    start(handler, connector.transaction!);
    handler.onWebSocketClosed();
    await settle();
    expect(rejected).toEqual([]);
    expect(clock.pending).toBe(0);
  });

  it("leaves OCPP 1.5 as it is: a Fault is logged and the request dropped", async () => {
    csms.script = { StartTransaction: ["fault"] };
    const { clock, connector, handler, rejected } = setup({}, OCPP15_DIALECT);
    start(handler, connector.transaction!);
    await settle();
    expect(csms.count("Heartbeat")).toBe(0);
    expect(rejected).toEqual([]);
    expect(clock.pending).toBe(0);
  });
});
