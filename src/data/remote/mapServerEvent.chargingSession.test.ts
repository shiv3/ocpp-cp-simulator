import { describe, expect, it } from "vitest";

import { activeChargingSession } from "../../test/chargingSessionFixtures";
import { mapServerEventToChargePointEvent } from "./RemoteChargePointService";

const session = activeChargingSession();

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
