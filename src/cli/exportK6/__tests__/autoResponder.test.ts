// src/cli/exportK6/__tests__/autoResponder.test.ts
import { describe, expect, it } from "vitest";
import {
  createResponderState,
  respondToCall16,
} from "../runtime/autoResponder";

describe("respondToCall16", () => {
  it("accepts remote start/stop by default", () => {
    const s = createResponderState();
    expect(
      respondToCall16("RemoteStartTransaction", { idTag: "T" }, s),
    ).toEqual({ status: "Accepted" });
    expect(
      respondToCall16("RemoteStopTransaction", { transactionId: 1 }, s),
    ).toEqual({ status: "Accepted" });
  });

  it("answers UnlockConnector from the armed unlock outcome", () => {
    const s = createResponderState();
    expect(respondToCall16("UnlockConnector", { connectorId: 1 }, s)).toEqual({
      status: "Unlocked",
    });
    s.unlockOutcome = "UnlockFailed";
    expect(respondToCall16("UnlockConnector", { connectorId: 1 }, s)).toEqual({
      status: "UnlockFailed",
    });
  });

  it("applies ChangeConfiguration to local config", () => {
    const s = createResponderState();
    expect(
      respondToCall16(
        "ChangeConfiguration",
        { key: "HeartbeatInterval", value: "60" },
        s,
      ),
    ).toEqual({ status: "Accepted" });
    expect(s.localConfig.get("HeartbeatInterval")).toBe("60");
  });

  it("returns known keys and unknown keys for GetConfiguration", () => {
    const s = createResponderState();
    s.localConfig.set("A", "1");
    expect(respondToCall16("GetConfiguration", { key: ["A", "B"] }, s)).toEqual(
      {
        configurationKey: [{ key: "A", readonly: false, value: "1" }],
        unknownKey: ["B"],
      },
    );
    expect(respondToCall16("GetConfiguration", {}, s)).toEqual({
      configurationKey: [{ key: "A", readonly: false, value: "1" }],
    });
  });

  it("consumes a one-shot armed override", () => {
    const s = createResponderState();
    s.armedOverrides.set("RemoteStartTransaction", "Rejected");
    expect(respondToCall16("RemoteStartTransaction", {}, s)).toEqual({
      status: "Rejected",
    });
    expect(respondToCall16("RemoteStartTransaction", {}, s)).toEqual({
      status: "Accepted",
    });
  });

  it("returns an empty conf for unknown actions", () => {
    expect(
      respondToCall16("GetDiagnostics", {}, createResponderState()),
    ).toEqual({});
  });
});
