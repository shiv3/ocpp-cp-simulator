import { afterEach, describe, expect, it, vi } from "vitest";
import { ChargePoint } from "../ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";

/**
 * #537 A02.FR.08: the switch to a renewed Charging Station certificate
 * reconnects a connected station only. One that is not connected (never
 * connected, in reconnect back-off, in a simulated outage) presents it at
 * its next connection, which keeps its own timing.
 */
function profile3Station(): ChargePoint {
  const cp = new ChargePoint(
    "CP-RENEW-UNIT",
    DefaultBootNotification,
    1,
    "wss://csms.example/ocpp",
    null,
    null,
    null,
    {},
    [],
    "OCPP-2.0.1",
    {},
    3,
    undefined,
    undefined,
    { cert: "CONFIGURED CERT", key: "CONFIGURED KEY" },
  );
  cp.events.on("error", () => undefined);
  return cp;
}

const IDENTITY = {
  cert: "RENEWED CERT",
  key: "RENEWED KEY",
  notBefore: new Date(0),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChargePoint.useRenewedClientCertificate", () => {
  it("does not reconnect a station that is not connected", async () => {
    const cp = profile3Station();
    vi.spyOn(cp.certificateStore, "tlsClientIdentity").mockResolvedValue(
      IDENTITY,
    );
    const reset = vi.spyOn(cp, "reset").mockImplementation(() => undefined);

    await cp.useRenewedClientCertificate();

    expect(reset).not.toHaveBeenCalled();
    cp.dispose();
  });
});
