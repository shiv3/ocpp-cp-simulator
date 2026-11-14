import { describe, expect, it } from "vitest";

import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { createChargePoint } from "../../../../infrastructure/charge-point/createChargePoint";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../../domain/types/OcppTypes";
import { decideRemoteStart } from "../remoteStartValidation";

function station(): ChargePoint {
  const cp = createChargePoint(
    "CP-RS",
    DefaultBootNotification,
    2,
    "ws://csms.example/ocpp",
    null,
    null,
    null,
    {},
    [],
    "OCPP-2.0.1",
    {},
  );
  cp.events.on("error", () => undefined);
  return cp;
}

const request = (idToken: string) =>
  ({ idToken: { idToken, type: "Central" } }) as Parameters<
    typeof decideRemoteStart
  >[1];

describe("decideRemoteStart without evseId (#839)", () => {
  it("does not pick an EVSE reserved for another idToken", () => {
    const cp = station();
    cp.reservationManager.createReservation(
      1,
      new Date(Date.now() + 3_600_000),
      "OTHER",
      undefined,
      7,
    );
    for (const c of cp.connectors.values()) c.status = OCPPStatus.Available;

    expect(decideRemoteStart(cp, request("ME"))).toEqual({
      ok: true,
      connectorId: 2,
    });
    cp.dispose();
  });

  it("rejects when every free EVSE is reserved for others", () => {
    const cp = station();
    for (const id of [1, 2]) {
      cp.reservationManager.createReservation(
        id,
        new Date(Date.now() + 3_600_000),
        "OTHER",
        undefined,
        id,
      );
    }
    for (const c of cp.connectors.values()) c.status = OCPPStatus.Available;

    expect(decideRemoteStart(cp, request("ME"))).toMatchObject({ ok: false });
    cp.dispose();
  });
});

describe("1.6 RemoteStartTransaction without connectorId (#839)", () => {
  it("tries the tag's own reserved connector first", async () => {
    const { pickRemoteStartConnector } = await import("../transaction");
    const cp = station();
    cp.reservationManager.createReservation(
      2,
      new Date(Date.now() + 3_600_000),
      "ME",
      undefined,
      9,
    );
    for (const c of cp.connectors.values()) c.status = OCPPStatus.Available;
    expect(pickRemoteStartConnector(cp, "ME")).toBe(2);
    // another tag skips the reserved connector
    expect(pickRemoteStartConnector(cp, "OTHER")).toBe(1);
    cp.dispose();
  });
});
