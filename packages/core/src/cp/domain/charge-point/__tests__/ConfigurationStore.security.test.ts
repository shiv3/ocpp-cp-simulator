import { describe, expect, it } from "vitest";

import type {
  ConfigurationOverrideRepository,
  StoredConfigurationOverride,
} from "../../persistence/ConfigurationOverrideRepository";
import type { ChargePoint } from "../ChargePoint";
import { defaultConfiguration } from "../Configuration";
import { ConfigurationStore } from "../ConfigurationStore";

const cpShape = {
  connectorNumber: 2,
  wsUrl: "ws://csms.example/ocpp/",
  ocppVersion: "OCPP-1.6J",
} as ChargePoint;

function storeWithDefaults(
  overrides: ConfigurationOverrideRepository | null = null,
  cpId = "cp-sec",
): ConfigurationStore {
  return new ConfigurationStore(cpId, defaultConfiguration(cpShape), overrides);
}

function entry(store: ConfigurationStore, key: string) {
  const found = store.get(key);
  if (!found) throw new Error(`Missing configuration key: ${key}`);
  return found;
}

/** One charge point's overrides, kept across the stores built on it. */
class MemoryConfigurationOverrides implements ConfigurationOverrideRepository {
  private readonly rows = new Map<string, string>();

  loadAll(): StoredConfigurationOverride[] {
    return Array.from(this.rows, ([key, value]) => ({ key, value }));
  }

  get(key: string): string | null {
    return this.rows.get(key) ?? null;
  }

  save(key: string, value: string): void {
    this.rows.set(key, value);
  }
}

describe("ConfigurationStore security whitepaper keys", () => {
  it("includes the six OCPP 1.6 Security Whitepaper keys with defaults and access modes", () => {
    const store = storeWithDefaults();

    expect(entry(store, "SecurityProfile")).toMatchObject({
      value: 0,
      key: { readonly: false, type: "integer" },
    });
    expect(entry(store, "AuthorizationKey")).toMatchObject({
      value: "",
      key: { readonly: false, writeonly: true, type: "string" },
    });
    expect(entry(store, "AdditionalRootCertificateCheck")).toMatchObject({
      value: false,
      key: { readonly: true, type: "boolean" },
    });
    expect(entry(store, "CertificateSignedMaxChainSize")).toMatchObject({
      value: 4,
      key: { readonly: true, type: "integer" },
    });
    expect(entry(store, "CertificateStoreMaxLength")).toMatchObject({
      value: 10,
      key: { readonly: true, type: "integer" },
    });
    expect(entry(store, "CpoName")).toMatchObject({
      value: "",
      key: { readonly: false, type: "string" },
    });
  });

  it("validates reads and ChangeConfiguration mutations", () => {
    const store = storeWithDefaults();

    // No guard (a transport without the security extension, OCPP-S): the
    // value is stored and the change needs a reboot, as before #724.
    expect(store.applyChange("SecurityProfile", "2")).toBe("RebootRequired");
    expect(store.getInteger("SecurityProfile")).toBe(2);

    expect(store.applyChange("SecurityProfile", "4")).toBe("Rejected");
    expect(store.applyChange("SecurityProfile", "1.5")).toBe("Rejected");
    expect(store.getInteger("SecurityProfile")).toBe(2);

    expect(store.applyChange("AuthorizationKey", "super-secret-key")).toBe(
      "Accepted",
    );
    expect(store.getString("AuthorizationKey")).toBe("super-secret-key");
    expect(store.readRedacted(["AuthorizationKey"]).known[0]?.value).toBe("");

    expect(store.applyChange("CpoName", "Acme CPO")).toBe("Accepted");
    expect(store.getString("CpoName")).toBe("Acme CPO");

    expect(store.applyChange("AdditionalRootCertificateCheck", "true")).toBe(
      "Rejected",
    );
    expect(store.applyChange("UnknownSecurityKey", "x")).toBe("NotSupported");
  });

  it("answers Rejected and keeps SecurityProfile when the A05 guard refuses (#724)", () => {
    const store = storeWithDefaults();
    const seen: Array<[number, number]> = [];
    let allow = false;
    store.setChangeGuard("SecurityProfile", (current, next) => {
      seen.push([current as number, next as number]);
      return allow;
    });

    expect(store.applyChange("SecurityProfile", "2")).toBe("Rejected");
    expect(store.getInteger("SecurityProfile")).toBe(0);
    allow = true;
    expect(store.applyChange("SecurityProfile", "2")).toBe("Accepted");
    expect(store.getInteger("SecurityProfile")).toBe(2);
    // Other keys and a bypassing change never reach the guard.
    expect(store.applyChange("CpoName", "x")).toBe("Accepted");
    allow = false;
    expect(
      store.applyChange("SecurityProfile", "1", { bypassGuard: true }),
    ).toBe("Accepted");
    expect(store.getInteger("SecurityProfile")).toBe(1);
    expect(seen).toEqual([
      [0, 2],
      [0, 2],
    ]);
  });

  it("answers Rejected and keeps AuthorizationKey when its guard refuses (#724)", () => {
    const store = storeWithDefaults();
    store.applyChange("AuthorizationKey", "00112233445566778899aabbccddeeff");
    store.setChangeGuard("AuthorizationKey", (_current, next) => next !== "");
    expect(store.applyChange("AuthorizationKey", "")).toBe("Rejected");
    expect(store.getString("AuthorizationKey")).toBe(
      "00112233445566778899aabbccddeeff",
    );
    expect(store.applyChange("AuthorizationKey", "ab".repeat(16))).toBe(
      "Accepted",
    );
  });

  it("round-trips mutable security keys through persistence", () => {
    const db = new MemoryConfigurationOverrides();
    const first = storeWithDefaults(db);

    expect(first.applyChange("SecurityProfile", "3")).toBe("RebootRequired");
    expect(first.applyChange("AuthorizationKey", "persisted-secret")).toBe(
      "Accepted",
    );
    expect(first.applyChange("CpoName", "Persisted CPO")).toBe("Accepted");

    const second = storeWithDefaults(db);
    expect(second.getInteger("SecurityProfile")).toBe(3);
    expect(second.getString("AuthorizationKey")).toBe("persisted-secret");
    expect(second.getString("CpoName")).toBe("Persisted CPO");
    expect(second.readRedacted(["AuthorizationKey"]).known[0]?.value).toBe("");
  });
});
