import { describe, expect, it } from "vitest";
import {
  checkNetworkProfile,
  NetworkProfileStore,
  type NetworkConnectionProfile,
  type NetworkProfileCheckInput,
} from "../networkProfiles";

// B09 SetNetworkProfile: what the station accepts into a configuration slot.

const profile = (
  over: Partial<NetworkConnectionProfile> = {},
): NetworkConnectionProfile => ({
  ocppVersion: "OCPP20",
  ocppTransport: "JSON",
  ocppCsmsUrl: "wss://csms.example/ocpp/",
  messageTimeout: 30,
  securityProfile: 2,
  ocppInterface: "Wired0",
  ...over,
});

const check = (
  p: NetworkConnectionProfile,
  over: Partial<Omit<NetworkProfileCheckInput, "profile">> = {},
) =>
  checkNetworkProfile({
    configurationSlot: 1,
    currentSecurityProfile: 1,
    allowSecurityProfileDowngrade: false,
    ...over,
    profile: p,
  });

const reason = (v: ReturnType<typeof checkNetworkProfile>) =>
  v.accepted ? "Accepted" : v.reasonCode;

describe("checkNetworkProfile (B09)", () => {
  it("accepts a valid profile (B09.FR.02)", () => {
    expect(check(profile())).toEqual({ accepted: true });
    // 2.1: ocppVersion is optional.
    expect(check(profile({ ocppVersion: undefined }))).toEqual({
      accepted: true,
    });
    expect(
      check(profile({ securityProfile: 1, ocppCsmsUrl: "ws://h:9000/ocpp" })),
    ).toEqual({ accepted: true });
  });

  it("rejects invalid content with a reasonCode (B09.FR.01)", () => {
    expect(reason(check(profile(), { configurationSlot: -1 }))).toBe(
      "InvalidConfSlot",
    );
    expect(reason(check(profile(), { configurationSlot: 10 }))).toBe(
      "InvalidConfSlot",
    );
    expect(reason(check(profile({ ocppTransport: "SOAP" })))).toBe(
      "UnsupportedParam",
    );
    expect(reason(check(profile({ ocppVersion: "OCPP16" })))).toBe(
      "UnsupportedParam",
    );
    expect(reason(check(profile({ ocppCsmsUrl: "not a url" })))).toBe(
      "InvalidURL",
    );
    expect(
      reason(check(profile({ ocppCsmsUrl: "https://csms.example/ocpp" }))),
    ).toBe("InvalidURL");
    expect(
      reason(check(profile({ ocppCsmsUrl: "wss://csms.example/ocpp?x=1" }))),
    ).toBe("InvalidURL");
    expect(reason(check(profile({ messageTimeout: 0 })))).toBe(
      "InvalidNetworkConf",
    );
    expect(reason(check(profile({ securityProfile: 4 })))).toBe(
      "InvalidNetworkConf",
    );
    // Profiles 2 and 3 run over TLS.
    expect(
      reason(check(profile({ ocppCsmsUrl: "ws://csms.example/ocpp" }))),
    ).toBe("InvalidNetworkConf");
    expect(reason(check(profile({ basicAuthPassword: "short" })))).toBe(
      "InvalidNetworkConf",
    );
  });

  it("rejects a lower security profile while AllowSecurityProfileDowngrade is false (B09.FR.04)", () => {
    const v = check(profile({ securityProfile: 2 }), {
      currentSecurityProfile: 3,
    });
    expect(reason(v)).toBe("NoSecurityDowngrade");
    // Equal or higher is not a downgrade.
    expect(
      check(profile({ securityProfile: 3 }), { currentSecurityProfile: 3 }),
    ).toEqual({ accepted: true });
  });

  it("with AllowSecurityProfileDowngrade, allows 3 -> 2 and nothing lower", () => {
    const allow = {
      currentSecurityProfile: 3,
      allowSecurityProfileDowngrade: true,
    };
    expect(check(profile({ securityProfile: 2 }), allow)).toEqual({
      accepted: true,
    });
    expect(
      reason(
        check(
          profile({ securityProfile: 1, ocppCsmsUrl: "ws://csms.example/" }),
          allow,
        ),
      ),
    ).toBe("NoSecurityDowngrade");
    expect(
      reason(
        check(
          profile({ securityProfile: 1, ocppCsmsUrl: "wss://csms.example/" }),
          { currentSecurityProfile: 2, allowSecurityProfileDowngrade: true },
        ),
      ),
    ).toBe("NoSecurityDowngrade");
  });
});

describe("NetworkProfileStore", () => {
  it("keeps one profile per slot; a later one replaces it", () => {
    const store = new NetworkProfileStore();
    store.set(2, profile());
    store.set(0, profile({ securityProfile: 3 }));
    store.set(2, profile({ messageTimeout: 60 }));
    expect(store.slots()).toEqual([0, 2]);
    expect(store.get(2)?.messageTimeout).toBe(60);
    expect(store.get(1)).toBeUndefined();
  });
});
