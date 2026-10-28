import { describe, expect, it } from "vitest";

import { mapServerEventToChargePointEvent } from "./RemoteChargePointService";

const session = {
  sessionId: "s-1",
  cpId: "CP-1",
  connectorId: 1,
  evseId: null,
  ocppVersion: "OCPP-1.6J",
  transactionId: "42",
  idTag: "TAG",
  startedAt: "2026-10-28T10:00:00.000Z",
  endedAt: null,
  durationMs: null,
  meterStartWh: 0,
  meterStopWh: null,
  energyWh: null,
  stopReason: null,
  triggerReason: null,
  authorizationStatus: null,
  outcome: "active",
};

describe("mapServerEventToChargePointEvent charging_session (#447)", () => {
  it("maps the daemon event to charging-session", () => {
    expect(
      mapServerEventToChargePointEvent({
        event: "charging_session",
        data: session,
      } as never),
    ).toEqual({ type: "charging-session", session });
  });

  it("drops a session without an id: it cannot be placed", () => {
    const { sessionId: _sessionId, ...withoutId } = session;
    expect(
      mapServerEventToChargePointEvent({
        event: "charging_session",
        data: withoutId,
      } as never),
    ).toBeNull();
  });
});
