import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@open-ocpp-trace/core";
import type { TraceRecord } from "@open-ocpp-trace/core";
import { MAX_PENDING_CORRELATIONS, TraceCorrelator } from "../TraceCorrelator";

// The correlator only reads messageId / chargePointId / action, so the
// fixtures leave out what the discriminated union requires per type (a
// CALL's action, a CALLERROR's error) when a test is about its absence.
function record(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    timestamp: "2026-07-14T02:00:00.000Z",
    transport: "json",
    direction: "cp-to-csms",
    messageType: "CALL",
    ...overrides,
  } as TraceRecord;
}

describe("TraceCorrelator", () => {
  it("back-fills a CALLRESULT's action from a CALL observed earlier, one record at a time", () => {
    const correlator = new TraceCorrelator();

    const call = record({
      messageType: "CALL",
      messageId: "m-1",
      action: "BootNotification",
    });
    correlator.observe(call);

    const result = record({
      messageType: "CALLRESULT",
      messageId: "m-1",
      direction: "csms-to-cp",
    });
    correlator.observe(result);

    expect(result.action).toBe("BootNotification");
  });

  it("back-fills a CALLERROR's action from a CALL observed earlier", () => {
    const correlator = new TraceCorrelator();

    correlator.observe(
      record({ messageType: "CALL", messageId: "m-2", action: "Heartbeat" }),
    );
    const error = record({
      messageType: "CALLERROR",
      messageId: "m-2",
      direction: "csms-to-cp",
      error: { code: "NotSupported" },
    });
    correlator.observe(error);

    expect(error.action).toBe("Heartbeat");
  });

  it("returns the same record instance it was given", () => {
    const correlator = new TraceCorrelator();
    const call = record({ messageId: "m-3", action: "Heartbeat" });
    expect(correlator.observe(call)).toBe(call);
  });

  it("leaves an uncorrelated CALLRESULT's action undefined", () => {
    const correlator = new TraceCorrelator();
    const result = record({
      messageType: "CALLRESULT",
      messageId: "orphan",
      direction: "csms-to-cp",
    });
    correlator.observe(result);
    expect(result.action).toBeUndefined();
  });

  it("scopes correlation per charge point, not globally by messageId alone", () => {
    const correlator = new TraceCorrelator();

    correlator.observe(
      record({
        messageId: "1",
        action: "BootNotification",
        chargePointId: "CP-A",
      }),
    );
    correlator.observe(
      record({ messageId: "1", action: "Heartbeat", chargePointId: "CP-B" }),
    );

    const resultA = record({
      messageType: "CALLRESULT",
      messageId: "1",
      direction: "csms-to-cp",
      chargePointId: "CP-A",
    });
    const resultB = record({
      messageType: "CALLRESULT",
      messageId: "1",
      direction: "csms-to-cp",
      chargePointId: "CP-B",
    });
    correlator.observe(resultA);
    correlator.observe(resultB);

    expect(resultA.action).toBe("BootNotification");
    expect(resultB.action).toBe("Heartbeat");
  });

  it("does not touch a record with no messageId", () => {
    const correlator = new TraceCorrelator();
    const noId = record({ messageId: undefined });
    correlator.observe(noId);
    expect(noId.action).toBeUndefined();
  });

  it("evicts the correlation entry once a CALLRESULT/CALLERROR consumes it, so a second response with the same messageId gets no action", () => {
    const correlator = new TraceCorrelator();

    correlator.observe(
      record({ messageType: "CALL", messageId: "m-1", action: "Heartbeat" }),
    );

    const firstResult = record({
      messageType: "CALLRESULT",
      messageId: "m-1",
      direction: "csms-to-cp",
    });
    correlator.observe(firstResult);
    expect(firstResult.action).toBe("Heartbeat");

    // OCPP-J has exactly one response per CALL. A second response reusing
    // the same messageId (e.g. after the id space wraps around on a
    // long-running daemon) must not resolve to the stale action — the
    // entry should have been evicted on first consumption.
    const secondResult = record({
      messageType: "CALLRESULT",
      messageId: "m-1",
      direction: "csms-to-cp",
    });
    correlator.observe(secondResult);
    expect(secondResult.action).toBeUndefined();
  });

  it("evicts the oldest pending CALL when the cap is reached, so responses to evicted CALLs do not resolve", () => {
    const correlator = new TraceCorrelator();

    // Feed MAX_PENDING_CORRELATIONS + 1 distinct CALL records
    for (let i = 0; i <= MAX_PENDING_CORRELATIONS; i++) {
      correlator.observe(
        record({
          messageType: "CALL",
          messageId: `m-${i}`,
          action: `Action${i}`,
        }),
      );
    }

    // CALLRESULT for the first messageId (evicted) should get no action
    const firstResult = record({
      messageType: "CALLRESULT",
      messageId: "m-0",
      direction: "csms-to-cp",
    });
    correlator.observe(firstResult);
    expect(firstResult.action).toBeUndefined();

    // CALLRESULT for the second messageId should still get its action
    const secondResult = record({
      messageType: "CALLRESULT",
      messageId: "m-1",
      direction: "csms-to-cp",
    });
    correlator.observe(secondResult);
    expect(secondResult.action).toBe("Action1");
  });
});

describe("TraceCorrelator connectorId (#999)", () => {
  const response = (
    messageId: string,
    overrides: Partial<TraceRecord> = {},
  ): TraceRecord =>
    record({
      messageType: "CALLRESULT",
      direction: "csms-to-cp",
      messageId,
      ...overrides,
    } as Partial<TraceRecord>);

  it("gives a CALLRESULT and a CALLERROR the connector of their CALL", () => {
    const correlator = new TraceCorrelator();
    correlator.observe(
      record({ messageId: "a", action: "StatusNotification", connectorId: 2 }),
    );
    correlator.observe(
      record({ messageId: "b", action: "UnlockConnector", connectorId: 0 }),
    );
    const result = correlator.observe(response("a"));
    const error = correlator.observe(
      response("b", { messageType: "CALLERROR", error: { code: "X" } }),
    );
    expect(result.connectorId).toBe(2);
    expect(error.connectorId).toBe(0);
  });

  it("leaves the response of a connector-less CALL without connectorId", () => {
    const correlator = new TraceCorrelator();
    correlator.observe(record({ messageId: "h", action: "Heartbeat" }));
    const result = correlator.observe(response("h"));
    expect(result).not.toHaveProperty("connectorId");
    expect(result.action).toBe("Heartbeat");
  });

  it("inserts a back-filled connectorId right after chargePointId, in place", () => {
    const correlator = new TraceCorrelator();
    correlator.observe(
      record({
        chargePointId: "CP",
        messageId: "a",
        action: "MeterValues",
        connectorId: 1,
      }),
    );
    // The converter's key order (logEntryToTrace's toRecord).
    const result = {
      schemaVersion: SCHEMA_VERSION,
      timestamp: "2026-07-14T02:00:00.000Z",
      transport: "json",
      direction: "csms-to-cp",
      messageType: "CALLRESULT",
      ocppVersion: "1.6",
      chargePointId: "CP",
      messageId: "a",
      payload: {},
      raw: '[3,"a",{}]',
    } as TraceRecord;
    expect(correlator.observe(result)).toBe(result);
    expect(Object.keys(result).join(" ")).toBe(
      "schemaVersion timestamp transport direction messageType ocppVersion chargePointId connectorId messageId payload raw action",
    );
  });

  it("inserts a back-filled connectorId before messageId when there is no chargePointId", () => {
    const correlator = new TraceCorrelator();
    correlator.observe(
      record({ messageId: "a", action: "MeterValues", connectorId: 1 }),
    );
    const result = correlator.observe(response("a", { payload: {} }));
    expect(Object.keys(result).join(" ")).toBe(
      "schemaVersion timestamp transport direction messageType connectorId messageId payload action",
    );
  });

  it("resolves StopTransaction and RemoteStopTransaction through the StartTransaction exchange", () => {
    const correlator = new TraceCorrelator();
    correlator.observe(
      record({ messageId: "s", action: "StartTransaction", connectorId: 3 }),
    );
    correlator.observe(response("s", { payload: { transactionId: 42 } }));

    const remoteStop = correlator.observe(
      record({
        direction: "csms-to-cp",
        messageId: "r",
        action: "RemoteStopTransaction",
        payload: { transactionId: 42 },
      }),
    );
    const remoteStopResult = correlator.observe(
      response("r", { direction: "cp-to-csms" }),
    );
    const stop = correlator.observe(
      record({
        messageId: "t",
        action: "StopTransaction",
        payload: { transactionId: 42, meterStop: 10 },
      }),
    );
    const stopResult = correlator.observe(response("t"));

    expect(remoteStop.connectorId).toBe(3);
    expect(remoteStopResult.connectorId).toBe(3);
    expect(stop.connectorId).toBe(3);
    expect(stopResult.connectorId).toBe(3);
  });

  it("scopes transactions per charge point", () => {
    const correlator = new TraceCorrelator();
    correlator.observe(
      record({
        chargePointId: "A",
        messageId: "s",
        action: "StartTransaction",
        connectorId: 1,
      }),
    );
    correlator.observe(
      response("s", { chargePointId: "A", payload: { transactionId: 5 } }),
    );
    const stopB = correlator.observe(
      record({
        chargePointId: "B",
        messageId: "t",
        action: "StopTransaction",
        payload: { transactionId: 5 },
      }),
    );
    expect(stopB).not.toHaveProperty("connectorId");
  });

  it.each([
    ["an unknown transaction", { transactionId: 99 }],
    ["a non-numeric transactionId", { transactionId: "42" }],
    ["no payload", undefined],
  ])("leaves a StopTransaction with %s without connectorId", (_, payload) => {
    const correlator = new TraceCorrelator();
    correlator.observe(
      record({ messageId: "s", action: "StartTransaction", connectorId: 3 }),
    );
    correlator.observe(response("s", { payload: { transactionId: 42 } }));
    const stop = correlator.observe(
      record({ messageId: "t", action: "StopTransaction", payload }),
    );
    expect(stop).not.toHaveProperty("connectorId");
  });

  it("learns no transaction from a StartTransaction without a connector or a rejected one", () => {
    const correlator = new TraceCorrelator();
    correlator.observe(record({ messageId: "s", action: "StartTransaction" }));
    correlator.observe(response("s", { payload: { transactionId: 1 } }));
    correlator.observe(
      record({ messageId: "u", action: "StartTransaction", connectorId: 2 }),
    );
    correlator.observe(
      response("u", {
        messageType: "CALLERROR",
        error: { code: "InternalError" },
      }),
    );
    const stop = correlator.observe(
      record({
        messageId: "t",
        action: "StopTransaction",
        payload: { transactionId: 1 },
      }),
    );
    expect(stop).not.toHaveProperty("connectorId");
  });

  it("keeps a connectorId a record already carries", () => {
    const correlator = new TraceCorrelator();
    correlator.observe(
      record({ messageId: "a", action: "StatusNotification", connectorId: 2 }),
    );
    const result = correlator.observe(response("a", { connectorId: 5 }));
    expect(result.connectorId).toBe(5);
  });

  it("caps the learned transactions, evicting the oldest", () => {
    const correlator = new TraceCorrelator();
    for (let i = 0; i <= MAX_PENDING_CORRELATIONS; i++) {
      correlator.observe(
        record({
          messageId: `s-${i}`,
          action: "StartTransaction",
          connectorId: 1,
        }),
      );
      correlator.observe(response(`s-${i}`, { payload: { transactionId: i } }));
    }
    const stop = (transactionId: number) =>
      correlator.observe(
        record({
          messageId: `t-${transactionId}`,
          action: "StopTransaction",
          payload: { transactionId },
        }),
      );
    expect(stop(0)).not.toHaveProperty("connectorId");
    expect(stop(1).connectorId).toBe(1);
  });
});
