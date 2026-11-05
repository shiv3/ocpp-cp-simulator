import { describe, expect, it } from "vitest";
import { ChargePoint } from "../ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";
import type { OcppTlsOptions } from "../../../infrastructure/transport/wsUrlWithBasic";

/**
 * #537, 1.6 whitepaper M04.FR.06: the trust anchors that validate the
 * current CSMS connection are the `--tls-ca` certificates of a `wss://`
 * connection that verifies the server.
 */
function chargePoint(url: string, tls?: OcppTlsOptions): ChargePoint {
  return new ChargePoint(
    "CP-TRUST",
    DefaultBootNotification,
    1,
    url,
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
    undefined,
    undefined,
    undefined,
    tls,
  );
}

describe("ChargePoint.connectionTrustAnchorsPem", () => {
  it("is the --tls-ca bundle of a wss:// connection", () => {
    expect(
      chargePoint("wss://csms.example/ocpp", {
        ca: "CA PEM",
      }).connectionTrustAnchorsPem(),
    ).toBe("CA PEM");
  });

  it.each([
    ["a ws:// connection", "ws://csms.example/ocpp", { ca: "CA PEM" }],
    ["no --tls-ca", "wss://csms.example/ocpp", undefined],
    [
      "server verification turned off",
      "wss://csms.example/ocpp",
      { ca: "CA PEM", rejectUnauthorized: false },
    ],
  ] as const)("is undefined with %s", (_case, url, tls) => {
    expect(chargePoint(url, tls).connectionTrustAnchorsPem()).toBeUndefined();
  });
});
