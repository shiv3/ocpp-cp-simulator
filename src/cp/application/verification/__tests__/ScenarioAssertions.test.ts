import { describe, it, expect } from "vitest";
import { evaluateAssertions, computeVerdict } from "../ScenarioAssertions";
import type { CallFrame, CallResultFrame, Frame } from "../ocpp";
import type {
  AssertionResult,
  AssertionSpec,
} from "../../scenario/ScenarioTypes";

/** Builds a synthetic wire transcript covering every assertion type this
 *  module supports, in a plausible OCPP wire order:
 *
 *   0. sent    CALL       BootNotification
 *   1. received CALLRESULT (Accepted)                       -- answers 0
 *   2. sent    CALL       StatusNotification (Preparing)
 *   3. received CALL      RemoteStartTransaction
 *   4. sent    CALLRESULT (Accepted)                        -- answers 3
 *   5. sent    CALL       StatusNotification (Charging)
 *   6. sent    CALL       StartTransaction
 *   7. received CALLRESULT (idTagInfo.status Accepted)      -- answers 6
 *   8. sent    CALL       MeterValues
 */
function call(
  direction: "sent" | "received",
  uniqueId: string,
  action: string,
  payload: unknown,
): CallFrame {
  return {
    kind: "call",
    direction,
    uniqueId,
    action,
    payload,
    timestamp: "2026-07-13T00:00:00.000Z",
    raw: `${direction === "sent" ? "Sent" : "Received"}: [2,"${uniqueId}","${action}",...]`,
  };
}

function result(
  direction: "sent" | "received",
  uniqueId: string,
  payload: unknown,
): CallResultFrame {
  return {
    kind: "callresult",
    direction,
    uniqueId,
    payload,
    timestamp: "2026-07-13T00:00:01.000Z",
    raw: `${direction === "sent" ? "Sent" : "Received"}: [3,"${uniqueId}",...]`,
  };
}

function buildTranscript(): Frame[] {
  return [
    call("sent", "b1", "BootNotification", { chargePointVendor: "V" }), // 0
    result("received", "b1", { status: "Accepted" }), // 1
    call("sent", "s1", "StatusNotification", {
      connectorId: 1,
      status: "Preparing",
    }), // 2
    call("received", "r1", "RemoteStartTransaction", {
      connectorId: 1,
      idTag: "TAG1",
    }), // 3
    result("sent", "r1", { status: "Accepted" }), // 4
    call("sent", "s2", "StatusNotification", {
      connectorId: 1,
      status: "Charging",
    }), // 5
    call("sent", "st1", "StartTransaction", {
      connectorId: 1,
      idTag: "TAG1",
      meterStart: 0,
    }), // 6
    result("received", "st1", {
      idTagInfo: { status: "Accepted" },
      transactionId: 1,
    }), // 7
    call("sent", "mv1", "MeterValues", { connectorId: 1, transactionId: 1 }), // 8
  ];
}

function evalOne(
  spec: AssertionSpec,
  frames: Frame[] = buildTranscript(),
): AssertionResult {
  const [r] = evaluateAssertions([spec], frames);
  return r;
}

describe("evaluateAssertions", () => {
  it("ocpp_sent: passes when the action was sent, fails otherwise", () => {
    expect(
      evalOne({ id: "a1", type: "ocpp_sent", action: "BootNotification" })
        .status,
    ).toBe("passed");
    expect(
      evalOne({ id: "a2", type: "ocpp_sent", action: "Reset" }).status,
    ).toBe("failed");
  });

  it("ocpp_sent: malformed (missing action) fails with a detail, not a throw", () => {
    const r = evalOne({ id: "a3", type: "ocpp_sent" });
    expect(r.status).toBe("failed");
    expect(r.detail).toMatch(/requires 'action'/);
  });

  it("ocpp_received: passes when the action was received, fails otherwise", () => {
    expect(
      evalOne({
        id: "b1",
        type: "ocpp_received",
        action: "RemoteStartTransaction",
      }).status,
    ).toBe("passed");
    expect(
      evalOne({ id: "b2", type: "ocpp_received", action: "ReserveNow" }).status,
    ).toBe("failed");
  });

  it("ocpp_absent: passes when the action was never sent (default direction), fails when it was", () => {
    expect(
      evalOne({ id: "c1", type: "ocpp_absent", action: "Reset" }).status,
    ).toBe("passed");
    expect(
      evalOne({ id: "c2", type: "ocpp_absent", action: "StatusNotification" })
        .status,
    ).toBe("failed");
  });

  it("ocpp_absent: respects an explicit direction", () => {
    // RemoteStartTransaction was received, not sent -- absent on "sent" passes.
    expect(
      evalOne({
        id: "c3",
        type: "ocpp_absent",
        action: "RemoteStartTransaction",
        direction: "sent",
      }).status,
    ).toBe("passed");
  });

  it("response_status: default direction 'received', pairs the CALLRESULT by uniqueId", () => {
    expect(
      evalOne({
        id: "d1",
        type: "response_status",
        action: "RemoteStartTransaction",
        status: "Accepted",
      }).status,
    ).toBe("passed");
    const failing = evalOne({
      id: "d2",
      type: "response_status",
      action: "RemoteStartTransaction",
      status: "Rejected",
    });
    expect(failing.status).toBe("failed");
    expect(failing.detail).toMatch(/expected status=Rejected/);
  });

  it("response_status: malformed (missing status) fails with a detail", () => {
    const r = evalOne({
      id: "d3",
      type: "response_status",
      action: "RemoteStartTransaction",
    });
    expect(r.status).toBe("failed");
    expect(r.detail).toMatch(/requires 'action' and 'status'/);
  });

  it("idtag_info_status: default direction 'sent', checks payload.idTagInfo.status", () => {
    expect(
      evalOne({
        id: "e1",
        type: "idtag_info_status",
        action: "StartTransaction",
        status: "Accepted",
      }).status,
    ).toBe("passed");
    expect(
      evalOne({
        id: "e2",
        type: "idtag_info_status",
        action: "StartTransaction",
        status: "Invalid",
      }).status,
    ).toBe("failed");
  });

  it("payload_match: passes on a deep-partial subset match, fails on mismatch", () => {
    expect(
      evalOne({
        id: "f1",
        type: "payload_match",
        action: "RemoteStartTransaction",
        direction: "received",
        payload: { idTag: "TAG1" },
      }).status,
    ).toBe("passed");
    expect(
      evalOne({
        id: "f2",
        type: "payload_match",
        action: "RemoteStartTransaction",
        direction: "received",
        payload: { idTag: "WRONG" },
      }).status,
    ).toBe("failed");
  });

  it("payload_match: malformed (missing payload) fails with a detail", () => {
    const r = evalOne({
      id: "f3",
      type: "payload_match",
      action: "RemoteStartTransaction",
      direction: "received",
    });
    expect(r.status).toBe("failed");
    expect(r.detail).toMatch(/requires 'action' and 'payload'/);
  });

  it("message_order: passes iff the first 'before' match precedes the first 'after' match", () => {
    expect(
      evalOne({
        id: "g1",
        type: "message_order",
        before: { action: "StatusNotification" },
        after: { action: "StartTransaction" },
      }).status,
    ).toBe("passed");
    expect(
      evalOne({
        id: "g2",
        type: "message_order",
        before: { action: "StartTransaction" },
        after: { action: "BootNotification" },
      }).status,
    ).toBe("failed");
  });

  it("message_order: malformed (missing before/after) fails with a detail", () => {
    const r = evalOne({ id: "g3", type: "message_order" });
    expect(r.status).toBe("failed");
    expect(r.detail).toMatch(/requires 'before' and 'after'/);
  });

  it("message_after: passes iff an 'after' match occurs strictly after the LAST 'before' match", () => {
    expect(
      evalOne({
        id: "h1",
        type: "message_after",
        before: { action: "RemoteStartTransaction", direction: "received" },
        after: { action: "StartTransaction" },
      }).status,
    ).toBe("passed");
    // BootNotification (index 0) is before RemoteStartTransaction (index 3),
    // so it can never satisfy "after".
    expect(
      evalOne({
        id: "h2",
        type: "message_after",
        before: { action: "RemoteStartTransaction", direction: "received" },
        after: { action: "BootNotification" },
      }).status,
    ).toBe("failed");
  });

  it("state_transition: passes iff a sent StatusNotification with the target status exists", () => {
    expect(
      evalOne({ id: "i1", type: "state_transition", targetStatus: "Charging" })
        .status,
    ).toBe("passed");
    expect(
      evalOne({ id: "i2", type: "state_transition", targetStatus: "Faulted" })
        .status,
    ).toBe("failed");
  });

  it("no_unexpected: passes iff none of the listed actions were sent", () => {
    expect(
      evalOne({
        id: "j1",
        type: "no_unexpected",
        actions: ["Reset", "UpdateFirmware"],
      }).status,
    ).toBe("passed");
    const failing = evalOne({
      id: "j2",
      type: "no_unexpected",
      actions: ["StatusNotification", "Reset"],
    });
    expect(failing.status).toBe("failed");
    expect(failing.detail).toMatch(/StatusNotification/);
  });

  it("no_unexpected: malformed (empty actions) fails with a detail", () => {
    const r = evalOne({ id: "j3", type: "no_unexpected", actions: [] });
    expect(r.status).toBe("failed");
    expect(r.detail).toMatch(/non-empty 'actions'/);
  });

  it("evaluates every spec, one result per spec, in declaration order", () => {
    const specs: AssertionSpec[] = [
      { id: "k1", type: "ocpp_sent", action: "BootNotification" },
      { id: "k2", type: "state_transition", targetStatus: "Charging" },
      { id: "k3", type: "ocpp_sent", action: "NeverSent" },
    ];
    const results = evaluateAssertions(specs, buildTranscript());
    expect(results.map((r) => r.id)).toEqual(["k1", "k2", "k3"]);
    expect(results.map((r) => r.status)).toEqual([
      "passed",
      "passed",
      "failed",
    ]);
  });

  it("uses spec.description when provided instead of the default", () => {
    const r = evalOne({
      id: "l1",
      type: "ocpp_sent",
      action: "BootNotification",
      description: "boot happened",
    });
    expect(r.description).toBe("boot happened");
  });
});

describe("computeVerdict", () => {
  const passed: AssertionResult = {
    id: "p",
    type: "ocpp_sent",
    status: "passed",
    description: "p",
  };
  const failed: AssertionResult = {
    id: "f",
    type: "ocpp_sent",
    status: "failed",
    description: "f",
  };
  const skipped: AssertionResult = {
    id: "s",
    type: "ocpp_sent",
    status: "skipped",
    description: "s",
  };

  it("SKIPPED when there are no results", () => {
    expect(computeVerdict([], { executionState: "completed" })).toBe("SKIPPED");
  });

  it("SKIPPED when every result is skipped", () => {
    expect(
      computeVerdict([skipped, skipped], { executionState: "completed" }),
    ).toBe("SKIPPED");
  });

  it("PASS when every result passed", () => {
    expect(
      computeVerdict([passed, passed], { executionState: "completed" }),
    ).toBe("PASS");
  });

  it("FAIL when at least one result failed", () => {
    expect(
      computeVerdict([passed, failed], { executionState: "completed" }),
    ).toBe("FAIL");
  });

  it("BLOCKED on an errored execution, outranking a failure", () => {
    expect(computeVerdict([passed, failed], { executionState: "error" })).toBe(
      "BLOCKED",
    );
  });

  it("BLOCKED when opts.blocked is true, even with otherwise-passing results", () => {
    expect(
      computeVerdict([passed, passed], {
        executionState: "completed",
        blocked: true,
      }),
    ).toBe("BLOCKED");
  });
});
