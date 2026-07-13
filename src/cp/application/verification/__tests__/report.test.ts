import { describe, expect, it } from "vitest";
import {
  frameToTranscriptEntry,
  redactTranscriptEntry,
} from "../ScenarioAssertions";
import type { Frame } from "../ocpp";

const base = {
  direction: "sent" as const,
  uniqueId: "u1",
  timestamp: "2026-07-13T00:00:00Z",
  raw: "raw",
};

describe("frameToTranscriptEntry (#179 Phase 3)", () => {
  it("maps a call frame (keeps action + payload)", () => {
    const frame: Frame = {
      ...base,
      kind: "call",
      action: "BootNotification",
      payload: { chargePointModel: "m" },
    };
    expect(frameToTranscriptEntry(frame, 0)).toEqual({
      seq: 0,
      ts: "2026-07-13T00:00:00Z",
      direction: "sent",
      uniqueId: "u1",
      kind: "call",
      action: "BootNotification",
      payload: { chargePointModel: "m" },
    });
  });

  it("maps a callresult frame (payload, no action)", () => {
    const frame: Frame = {
      ...base,
      direction: "received",
      kind: "callresult",
      payload: { status: "Accepted" },
    };
    const entry = frameToTranscriptEntry(frame, 3);
    expect(entry.kind).toBe("callresult");
    expect(entry.seq).toBe(3);
    expect(entry.payload).toEqual({ status: "Accepted" });
    expect(entry.action).toBeUndefined();
  });

  it("maps a callerror frame (errorCode/description, no payload)", () => {
    const frame: Frame = {
      ...base,
      direction: "received",
      kind: "callerror",
      errorCode: "InternalError",
      errorDescription: "boom",
      errorDetails: {},
    };
    const entry = frameToTranscriptEntry(frame, 1);
    expect(entry.kind).toBe("callerror");
    expect(entry.errorCode).toBe("InternalError");
    expect(entry.errorDescription).toBe("boom");
    expect(entry.payload).toBeUndefined();
  });
});

describe("redactTranscriptEntry (#179 Phase 3)", () => {
  it("redacts sensitive material from a call payload", () => {
    const frame: Frame = {
      ...base,
      kind: "call",
      action: "ChangeConfiguration",
      payload: { key: "AuthorizationKey", value: "DEADBEEFCAFE" },
    };
    const redacted = redactTranscriptEntry(frameToTranscriptEntry(frame, 0));
    // The OCPP key/value secret must not survive into the report.
    expect(JSON.stringify(redacted.payload)).not.toContain("DEADBEEFCAFE");
  });

  it("does not mutate the input entry", () => {
    const frame: Frame = {
      ...base,
      kind: "call",
      action: "ChangeConfiguration",
      payload: { key: "AuthorizationKey", value: "SECRET" },
    };
    const entry = frameToTranscriptEntry(frame, 0);
    redactTranscriptEntry(entry);
    // Original entry untouched.
    expect(JSON.stringify(entry.payload)).toContain("SECRET");
  });

  it("redacts a callerror's free-text description", () => {
    const frame: Frame = {
      ...base,
      direction: "received",
      kind: "callerror",
      errorCode: "SecurityError",
      errorDescription: "password=hunter2 rejected",
      errorDetails: {},
    };
    const redacted = redactTranscriptEntry(frameToTranscriptEntry(frame, 0));
    expect(redacted.errorDescription).not.toContain("hunter2");
  });
});
