import { describe, it, expect } from "bun:test";

import { CLIChargePointService } from "../service";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import type { Transaction } from "../../cp/domain/connector/Transaction";

/**
 * #328: a CSMS that assigns `transactionId: 0` must be observable.
 *
 * OCPP 1.6 makes `transactionId` schema-valid for any integer, zero included.
 * `CLIChargePointService` re-emits `transaction_started` when the connector's
 * `transactionIdChange` fires with the CSMS-assigned id, but it used to skip
 * the re-emission for `0` on the reasoning that the local placeholder had
 * "already been emitted on start" — a path that does not exist, since the
 * setter is reached only from the CALLRESULT handlers. The effect was that a
 * subscriber could not tell "the CSMS assigned 0" from "no confirmation yet".
 *
 * The trap this file avoids: asserting on a *truthy* id passes with the bug
 * present. Every assertion below compares with `toBe(0)` / `toBe(null)`.
 */
type Emitted = { readonly event: string; readonly data?: unknown };

function harness() {
  const svc = new CLIChargePointService(
    {
      cpId: "cp-328",
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 1,
      vendor: "v",
      model: "m",
      basicAuth: null,
    },
    null,
  );
  const events: Emitted[] = [];
  svc.onEvent((evt) => events.push(evt as Emitted));
  const connector = (
    svc as unknown as { _chargePoint: ChargePoint }
  )._chargePoint.connectors.get(1);
  if (!connector) throw new Error("connector 1 missing");
  return { svc, events, connector };
}

function localStart(): Transaction {
  return {
    id: 0,
    connectorId: 1,
    tagId: "TAG-328",
    meterStart: 0,
    meterStop: null,
    startTime: new Date("2026-09-17T00:00:00Z"),
    stopTime: null,
    meterSent: false,
  };
}

function startedIds(events: readonly Emitted[]): Array<number | null> {
  return events
    .filter((evt) => evt.event === "transaction_started")
    .map((evt) => (evt.data as { transactionId: number | null }).transactionId);
}

describe("transaction_started re-emission carries the assigned id, zero included (#328)", () => {
  it("a CSMS assigning transactionId 0 produces an observable transaction_started with 0", () => {
    const { svc, events, connector } = harness();
    try {
      connector.beginTransaction(localStart());
      const before = startedIds(events).length;

      // StartTransaction.conf: { transactionId: 0 } — what the CALLRESULT
      // handler does with a conforming CSMS's answer.
      connector.transactionId = 0;

      const emitted = startedIds(events).slice(before);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toBe(0);
      const evt = events.at(-1) as {
        data: { connectorId: number; transactionId: number; tagId: string };
      };
      expect(evt.data.connectorId).toBe(1);
      expect(evt.data.tagId).toBe("TAG-328");
    } finally {
      svc.cleanup();
    }
  });

  it("a non-zero assignment is unchanged: one re-emission with that id", () => {
    const { svc, events, connector } = harness();
    try {
      connector.beginTransaction(localStart());
      const before = startedIds(events).length;
      connector.transactionId = 4242;
      expect(startedIds(events).slice(before)).toEqual([4242]);
    } finally {
      svc.cleanup();
    }
  });

  it("clearing the id still emits transaction_stopped, not transaction_started", () => {
    const { svc, events, connector } = harness();
    try {
      connector.beginTransaction(localStart());
      connector.transactionId = 0;
      const before = events.length;
      connector.transactionId = null;
      const after = events.slice(before);
      expect(after.map((evt) => evt.event)).toEqual(["transaction_stopped"]);
      expect(
        (after[0].data as { transactionId: number | null }).transactionId,
      ).toBe(0);
    } finally {
      svc.cleanup();
    }
  });
});
