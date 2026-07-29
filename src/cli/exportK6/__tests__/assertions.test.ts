// src/cli/exportK6/__tests__/assertions.test.ts
import { describe, expect, it } from "vitest";
import { evaluateAssertions } from "../runtime/assertions";
import type { TranscriptEntry } from "../runtime/types";

function sent(
  action: string,
  payload: Record<string, unknown> = {},
  response?: Record<string, unknown>,
): TranscriptEntry {
  return { direction: "sent", action, payload, response, timeMs: 0 };
}
function received(
  action: string,
  payload: Record<string, unknown> = {},
): TranscriptEntry {
  return { direction: "received", action, payload, timeMs: 0 };
}

const T: TranscriptEntry[] = [
  sent("BootNotification", {}, { status: "Accepted" }),
  sent("StatusNotification", { status: "Preparing" }),
  sent(
    "StartTransaction",
    { idTag: "T" },
    { transactionId: 1, idTagInfo: { status: "Accepted" } },
  ),
  received("RemoteStopTransaction", { transactionId: 1 }),
  sent(
    "StopTransaction",
    { transactionId: 1 },
    { idTagInfo: { status: "Accepted" } },
  ),
  sent("StatusNotification", { status: "Available" }),
];

describe("evaluateAssertions", () => {
  it("checks ocpp_sent / ocpp_received / ocpp_absent", () => {
    const out = evaluateAssertions(
      [
        { id: "a", type: "ocpp_sent", action: "StartTransaction" },
        { id: "b", type: "ocpp_received", action: "RemoteStopTransaction" },
        { id: "c", type: "ocpp_absent", action: "Heartbeat" },
        { id: "d", type: "ocpp_sent", action: "Heartbeat" },
      ],
      T,
      "Available",
    );
    expect(out.map((o) => [o.id, o.ok])).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
      ["d", false],
    ]);
  });

  it("checks ocpp_sent occurrence counts", () => {
    const out = evaluateAssertions(
      [
        {
          id: "two",
          type: "ocpp_sent",
          action: "StatusNotification",
          occurrence: 2,
        },
        {
          id: "three",
          type: "ocpp_sent",
          action: "StatusNotification",
          occurrence: 3,
        },
      ],
      T,
      "Available",
    );
    expect(out.map((o) => o.ok)).toEqual([true, false]);
  });

  it("checks response_status and idtag_info_status", () => {
    const out = evaluateAssertions(
      [
        {
          id: "boot",
          type: "response_status",
          action: "BootNotification",
          status: "Accepted",
        },
        {
          id: "auth",
          type: "idtag_info_status",
          action: "StartTransaction",
          status: "Accepted",
        },
        {
          id: "bad",
          type: "response_status",
          action: "BootNotification",
          status: "Pending",
        },
      ],
      T,
      "Available",
    );
    expect(out.map((o) => o.ok)).toEqual([true, true, false]);
  });

  it("checks payload_match as a shallow subset", () => {
    const out = evaluateAssertions(
      [
        {
          id: "p",
          type: "payload_match",
          action: "StatusNotification",
          payload: { status: "Preparing" },
        },
        {
          id: "q",
          type: "payload_match",
          action: "StatusNotification",
          payload: { status: "Charging" },
        },
      ],
      T,
      "Available",
    );
    expect(out.map((o) => o.ok)).toEqual([true, false]);
  });

  it("checks message_order and message_after", () => {
    const out = evaluateAssertions(
      [
        {
          id: "ord",
          type: "message_order",
          actions: ["BootNotification", "StartTransaction", "StopTransaction"],
        },
        {
          id: "bad",
          type: "message_order",
          actions: ["StopTransaction", "BootNotification"],
        },
        {
          id: "aft",
          type: "message_after",
          action: "StopTransaction",
          after: { action: "RemoteStopTransaction" },
        },
      ],
      T,
      "Available",
    );
    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
  });

  it("checks state_transition against StatusNotification history and final status", () => {
    const out = evaluateAssertions(
      [
        { id: "s", type: "state_transition", targetStatus: "Preparing" },
        { id: "f", type: "state_transition", targetStatus: "Faulted" },
      ],
      T,
      "Available",
    );
    expect(out.map((o) => o.ok)).toEqual([true, false]);
  });

  it("checks no_unexpected (no CALLERRORs)", () => {
    const errT = [...T, { ...sent("MeterValues"), errorCode: "InternalError" }];
    expect(
      evaluateAssertions(
        [{ id: "n", type: "no_unexpected" }],
        T,
        "Available",
      )[0].ok,
    ).toBe(true);
    expect(
      evaluateAssertions(
        [{ id: "n", type: "no_unexpected" }],
        errT,
        "Available",
      )[0].ok,
    ).toBe(false);
  });

  it("fails unknown assertion types loudly", () => {
    const out = evaluateAssertions(
      [{ id: "u", type: "mystery" }],
      T,
      "Available",
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toMatch(/unsupported/i);
  });
});
