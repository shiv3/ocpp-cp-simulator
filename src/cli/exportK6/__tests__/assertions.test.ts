// src/cli/exportK6/__tests__/assertions.test.ts
//
// These tests encode the CANONICAL assertion semantics from
// src/cp/application/verification/ScenarioAssertions.ts (ported into
// runtime/assertions.ts for the k6 runtime), not the k6-runtime-specific
// shortcuts the original version of this file encoded. See
// runtime/assertions.ts's top-of-file comment for why the two engines must
// agree and what, if anything, can't be reproduced from a TranscriptEntry.
import { describe, expect, it } from "vitest";
import { evaluateAssertions } from "../runtime/assertions";
import type { TranscriptEntry } from "../runtime/types";

function sent(
  action: string,
  payload: Record<string, unknown> = {},
  response?: Record<string, unknown>,
  errorCode?: string,
): TranscriptEntry {
  return { direction: "sent", action, payload, response, errorCode, timeMs: 0 };
}
function received(
  action: string,
  payload: Record<string, unknown> = {},
): TranscriptEntry {
  return { direction: "received", action, payload, timeMs: 0 };
}

/**
 * A synthetic transcript covering every assertion type, in wire order:
 *
 *   0. sent     BootNotification                  -- response Accepted
 *   1. received RemoteStartTransaction (idTag TAG1) -- 1st occurrence
 *   2. sent     StartTransaction                   -- response idTagInfo Accepted
 *   3. received RemoteStartTransaction (idTag TAG1) -- LAST occurrence
 *   4. sent     StatusNotification (Charging)
 *   5. sent     StopTransaction                    -- CALLERROR InternalError
 *   6. sent     StatusNotification (Available)
 *
 * Entry 2's payload carries a nested object + array so payload_match can be
 * exercised against both shapes.
 */
const T: TranscriptEntry[] = [
  sent("BootNotification", {}, { status: "Accepted" }), // 0
  received("RemoteStartTransaction", { idTag: "TAG1" }), // 1
  sent(
    "StartTransaction",
    {
      idTag: "TAG1",
      meterStart: 0,
      extra: { nested: { level: 2, arr: [1, 2, 3] } },
    },
    { transactionId: 1, idTagInfo: { status: "Accepted" } },
  ), // 2
  received("RemoteStartTransaction", { idTag: "TAG1" }), // 3
  sent("StatusNotification", { status: "Charging" }), // 4
  sent("StopTransaction", { transactionId: 1 }, undefined, "InternalError"), // 5
  sent("StatusNotification", { status: "Available" }), // 6
];

describe("evaluateAssertions: ocpp_sent / ocpp_received", () => {
  it("passes iff the action exists in that direction (occurrence is not consulted)", () => {
    const out = evaluateAssertions(
      [
        { id: "a1", type: "ocpp_sent", action: "BootNotification" },
        { id: "a2", type: "ocpp_sent", action: "ReserveNow" },
        { id: "b1", type: "ocpp_received", action: "RemoteStartTransaction" },
        { id: "b2", type: "ocpp_received", action: "Reset" },
      ],
      T,
      "Available",
    );
    expect(out.map((o) => o.ok)).toEqual([true, false, true, false]);
  });

  it("malformed (missing action) fails with a detail, not a throw", () => {
    const out = evaluateAssertions(
      [
        { id: "a3", type: "ocpp_sent" },
        { id: "b3", type: "ocpp_received" },
      ],
      T,
      "Available",
    );
    expect(out.map((o) => o.ok)).toEqual([false, false]);
    expect(out[0].detail).toMatch(/requires 'action'/);
    expect(out[1].detail).toMatch(/requires 'action'/);
  });
});

describe("evaluateAssertions: ocpp_absent (direction defaults to 'sent' and matters)", () => {
  it("passes when the action wasn't sent, even though it WAS received", () => {
    const out = evaluateAssertions(
      [{ id: "c1", type: "ocpp_absent", action: "RemoteStartTransaction" }],
      T,
      "Available",
    );
    expect(out[0].ok).toBe(true);
  });

  it("fails when an explicit direction: 'received' override matches what was received", () => {
    const out = evaluateAssertions(
      [
        {
          id: "c2",
          type: "ocpp_absent",
          action: "RemoteStartTransaction",
          direction: "received",
        },
      ],
      T,
      "Available",
    );
    expect(out[0].ok).toBe(false);
  });

  it("fails when the action was sent (default direction)", () => {
    const out = evaluateAssertions(
      [{ id: "c3", type: "ocpp_absent", action: "StatusNotification" }],
      T,
      "Available",
    );
    expect(out[0].ok).toBe(false);
  });

  it("malformed (missing action) fails with a detail", () => {
    const out = evaluateAssertions([{ id: "c4", type: "ocpp_absent" }], T, "x");
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toMatch(/requires 'action'/);
  });
});

describe("evaluateAssertions: response_status", () => {
  it("default direction 'received' can't be evaluated -- the transcript never captures the auto-responder's reply", () => {
    const out = evaluateAssertions(
      [
        {
          id: "d1",
          type: "response_status",
          action: "RemoteStartTransaction",
          status: "Accepted",
        },
      ],
      T,
      "Available",
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toMatch(/direction=received/);
  });

  it("direction: 'sent' checks the recorded CSMS response", () => {
    const out = evaluateAssertions(
      [
        {
          id: "d2",
          type: "response_status",
          action: "BootNotification",
          status: "Accepted",
          direction: "sent",
        },
        {
          id: "d3",
          type: "response_status",
          action: "BootNotification",
          status: "Rejected",
          direction: "sent",
        },
      ],
      T,
      "Available",
    );
    expect(out.map((o) => o.ok)).toEqual([true, false]);
  });

  it("a CALLERROR-answered call fails with a detail naming the errorCode", () => {
    const out = evaluateAssertions(
      [
        {
          id: "d4",
          type: "response_status",
          action: "StopTransaction",
          status: "Accepted",
          direction: "sent",
        },
      ],
      T,
      "Available",
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toMatch(/errorCode=InternalError/);
  });

  it("malformed (missing status) fails with a detail", () => {
    const out = evaluateAssertions(
      [{ id: "d5", type: "response_status", action: "BootNotification" }],
      T,
      "x",
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toMatch(/requires 'action' and 'status'/);
  });
});

describe("evaluateAssertions: idtag_info_status", () => {
  it("default direction 'sent' checks payload.idTagInfo.status on the recorded response", () => {
    const out = evaluateAssertions(
      [
        {
          id: "e1",
          type: "idtag_info_status",
          action: "StartTransaction",
          status: "Accepted",
        },
        {
          id: "e2",
          type: "idtag_info_status",
          action: "StartTransaction",
          status: "Invalid",
        },
      ],
      T,
      "Available",
    );
    expect(out.map((o) => o.ok)).toEqual([true, false]);
  });

  it("malformed (missing action/status) fails with a detail", () => {
    const out = evaluateAssertions(
      [{ id: "e3", type: "idtag_info_status" }],
      T,
      "x",
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toMatch(/requires 'action' and 'status'/);
  });
});

describe("evaluateAssertions: payload_match (deep partial match)", () => {
  it("passes on a nested object subset", () => {
    const out = evaluateAssertions(
      [
        {
          id: "f1",
          type: "payload_match",
          action: "StartTransaction",
          payload: { extra: { nested: { level: 2 } } },
        },
      ],
      T,
      "Available",
    );
    expect(out[0].ok).toBe(true);
  });

  it("passes on an equal-length array compared element-wise", () => {
    const out = evaluateAssertions(
      [
        {
          id: "f2",
          type: "payload_match",
          action: "StartTransaction",
          payload: { extra: { nested: { arr: [1, 2, 3] } } },
        },
      ],
      T,
      "Available",
    );
    expect(out[0].ok).toBe(true);
  });

  it("fails when the array is a shorter prefix (length must match exactly)", () => {
    const out = evaluateAssertions(
      [
        {
          id: "f3",
          type: "payload_match",
          action: "StartTransaction",
          payload: { extra: { nested: { arr: [1, 2] } } },
        },
      ],
      T,
      "Available",
    );
    expect(out[0].ok).toBe(false);
  });

  it("malformed (missing payload) fails with a detail", () => {
    const out = evaluateAssertions(
      [{ id: "f4", type: "payload_match", action: "StartTransaction" }],
      T,
      "x",
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toMatch(/requires 'action' and 'payload'/);
  });
});

describe("evaluateAssertions: message_order", () => {
  it("passes iff the first 'before' match precedes the first 'after' match", () => {
    const out = evaluateAssertions(
      [
        {
          id: "g1",
          type: "message_order",
          before: { action: "BootNotification" },
          after: { action: "StopTransaction" },
        },
        {
          id: "g2",
          type: "message_order",
          before: { action: "StopTransaction" },
          after: { action: "BootNotification" },
        },
      ],
      T,
      "Available",
    );
    expect(out.map((o) => o.ok)).toEqual([true, false]);
  });

  it("malformed (missing 'after') fails with a detail", () => {
    const out = evaluateAssertions(
      [
        {
          id: "g3",
          type: "message_order",
          before: { action: "BootNotification" },
        },
      ],
      T,
      "x",
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toMatch(/requires 'before' and 'after'/);
  });
});

describe("evaluateAssertions: message_after (uses the LAST 'before' occurrence)", () => {
  it("fails when the only 'after' match sits before the LAST 'before' occurrence -- using the FIRST occurrence would wrongly pass this", () => {
    // RemoteStartTransaction is received twice (indices 1 and 3). The lone
    // StartTransaction (index 2) comes after the FIRST occurrence (1) but
    // before the LAST occurrence (3), so canonical semantics (last-before)
    // must fail this even though first-before would report a pass.
    const out = evaluateAssertions(
      [
        {
          id: "h1",
          type: "message_after",
          before: { action: "RemoteStartTransaction", direction: "received" },
          after: { action: "StartTransaction" },
        },
      ],
      T,
      "Available",
    );
    expect(out[0].ok).toBe(false);
  });

  it("passes when an 'after' match sits after the LAST 'before' occurrence", () => {
    const out = evaluateAssertions(
      [
        {
          id: "h2",
          type: "message_after",
          before: { action: "RemoteStartTransaction", direction: "received" },
          after: { action: "StopTransaction" },
        },
      ],
      T,
      "Available",
    );
    expect(out[0].ok).toBe(true);
  });

  it("malformed (missing 'before') fails with a detail", () => {
    const out = evaluateAssertions(
      [
        {
          id: "h3",
          type: "message_after",
          after: { action: "StopTransaction" },
        },
      ],
      T,
      "x",
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toMatch(/requires 'before' and 'after'/);
  });

  it("fails when the reference frame is never found", () => {
    const out = evaluateAssertions(
      [
        {
          id: "h4",
          type: "message_after",
          before: { action: "NeverHappened" },
          after: { action: "StopTransaction" },
        },
      ],
      T,
      "x",
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toMatch(/reference message not found/);
  });
});

describe("evaluateAssertions: state_transition (ignores finalStatus, matches canonical)", () => {
  it("passes when a matching StatusNotification was sent", () => {
    const out = evaluateAssertions(
      [{ id: "i1", type: "state_transition", targetStatus: "Charging" }],
      T,
      "SomethingElse",
    );
    expect(out[0].ok).toBe(true);
  });

  it("fails when no matching StatusNotification was sent, even if finalStatus matches", () => {
    // Regression guard: the old k6 implementation OR'd in `finalStatus`,
    // so this would have wrongly passed. Canonical only ever looks at sent
    // StatusNotification frames.
    const out = evaluateAssertions(
      [{ id: "i2", type: "state_transition", targetStatus: "Faulted" }],
      T,
      "Faulted",
    );
    expect(out[0].ok).toBe(false);
  });

  it("malformed (missing targetStatus) fails with a detail", () => {
    const out = evaluateAssertions(
      [{ id: "i3", type: "state_transition" }],
      T,
      "x",
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toMatch(/requires 'targetStatus'/);
  });
});

describe("evaluateAssertions: no_unexpected (checks a forbidden-actions list, not CALLERROR presence)", () => {
  it("passes iff none of the listed actions were sent", () => {
    const out = evaluateAssertions(
      [
        {
          id: "j1",
          type: "no_unexpected",
          actions: ["Reset", "UpdateFirmware"],
        },
      ],
      T,
      "Available",
    );
    expect(out[0].ok).toBe(true);
  });

  it("fails and names the unexpected action(s) that were sent", () => {
    const out = evaluateAssertions(
      [
        {
          id: "j2",
          type: "no_unexpected",
          actions: ["StatusNotification", "Reset"],
        },
      ],
      T,
      "Available",
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toMatch(/StatusNotification/);
  });

  it("malformed (empty actions) fails with a detail", () => {
    const out = evaluateAssertions(
      [{ id: "j3", type: "no_unexpected", actions: [] }],
      T,
      "x",
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toMatch(/non-empty 'actions'/);
  });
});

describe("evaluateAssertions: unknown types", () => {
  it("fails unknown assertion types loudly", () => {
    const out = evaluateAssertions([{ id: "u", type: "mystery" }], T, "x");
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toMatch(/unsupported/i);
  });
});

describe("evaluateAssertions: evaluation order", () => {
  it("evaluates every spec, one result per spec, in declaration order", () => {
    const out = evaluateAssertions(
      [
        { id: "k1", type: "ocpp_sent", action: "BootNotification" },
        { id: "k2", type: "state_transition", targetStatus: "Charging" },
        { id: "k3", type: "ocpp_sent", action: "NeverSent" },
      ],
      T,
      "Available",
    );
    expect(out.map((o) => o.id)).toEqual(["k1", "k2", "k3"]);
    expect(out.map((o) => o.ok)).toEqual([true, true, false]);
  });
});
