import { describe, expect, it } from "vitest";
import { OCPP_TRACE_SCHEMA_VERSION } from "../OcppTraceRecord";
import type { OcppTraceRecord } from "../OcppTraceRecord";
import { TraceCorrelator } from "../TraceCorrelator";

function record(overrides: Partial<OcppTraceRecord> = {}): OcppTraceRecord {
  return {
    schemaVersion: OCPP_TRACE_SCHEMA_VERSION,
    timestamp: "2026-07-14T02:00:00.000Z",
    transport: "json",
    direction: "cp-to-csms",
    messageType: "CALL",
    ...overrides,
  };
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
});
