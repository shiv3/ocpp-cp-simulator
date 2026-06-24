import { describe, expect, it } from "vitest";

import { outgoingV16Warning } from "../../codec/validateV16";
import { getProtocolProfile } from "../profiles";
import { ocppVersionToSubprotocol } from "../subprotocols";

describe("ProtocolProfile", () => {
  it("selects the OCPP 2.0.1 profile", () => {
    const profile = getProtocolProfile("OCPP-2.0.1");

    expect(profile.version).toBe("OCPP-2.0.1");
    expect(profile.subprotocol).toBe("ocpp2.0.1");
    expect(profile.codec.outgoingWarning("Heartbeat", {})).toBeNull();
  });

  it("selects the OCPP 1.6J profile for exact and fallback inputs", () => {
    const exactProfile = getProtocolProfile("OCPP-1.6J");
    const fallbackProfile = getProtocolProfile("garbage");

    expect(exactProfile.version).toBe("OCPP-1.6J");
    expect(exactProfile.subprotocol).toBe("ocpp1.6");
    expect(fallbackProfile.version).toBe("OCPP-1.6J");
    expect(fallbackProfile.subprotocol).toBe("ocpp1.6");
  });

  it("keeps the fallback subprotocol path aligned with the profile", () => {
    const fallbackSubprotocol = ocppVersionToSubprotocol("garbage");

    expect(fallbackSubprotocol).toBe("ocpp1.6");
    expect(fallbackSubprotocol).toBe(getProtocolProfile("garbage").subprotocol);
  });

  it("uses the exact v16 outgoing validator", () => {
    const invalidPayload = { chargePointVendor: "Vendor" };
    const validPayload = {
      chargePointVendor: "Vendor",
      chargePointModel: "Model",
    };
    const profile = getProtocolProfile("OCPP-1.6J");

    expect(
      profile.codec.outgoingWarning("BootNotification", invalidPayload),
    ).toBe(outgoingV16Warning("BootNotification", invalidPayload));
    expect(
      profile.codec.outgoingWarning("BootNotification", validPayload),
    ).toBe(outgoingV16Warning("BootNotification", validPayload));
    expect(
      profile.codec.outgoingWarning("BootNotification", validPayload),
    ).toBeNull();
  });

  it("exposes a message handler factory", () => {
    expect(typeof getProtocolProfile("OCPP-1.6J").createMessageHandler).toBe(
      "function",
    );
  });
});
