import { describe, expect, it } from "vitest";

import type { Database, SqlParam, SqlRow } from "../../persistence/Database";
import type { ChargePoint } from "../ChargePoint";
import { defaultConfiguration } from "../Configuration";
import { ConfigurationStore } from "../ConfigurationStore";

const cpShape = {
  connectorNumber: 2,
  wsUrl: "ws://csms.example/ocpp/",
} as ChargePoint;

function storeWithDefaults(
  database: Database | null = null,
  cpId = "cp-sec",
): ConfigurationStore {
  return new ConfigurationStore(cpId, defaultConfiguration(cpShape), database);
}

function entry(store: ConfigurationStore, key: string) {
  const found = store.get(key);
  if (!found) throw new Error(`Missing configuration key: ${key}`);
  return found;
}

class MemoryConfigurationDatabase implements Database {
  private readonly rows = new Map<string, string>();

  exec(): void {}

  run(_sql: string, params: SqlParam[] = []): void {
    const [cpId, key, value] = params;
    if (typeof cpId !== "string" || typeof key !== "string") return;
    this.rows.set(`${cpId}:${key}`, String(value));
  }

  all<T = SqlRow>(_sql: string, params: SqlParam[] = []): T[] {
    const [cpId] = params;
    if (typeof cpId !== "string") return [];

    const prefix = `${cpId}:`;
    return Array.from(this.rows.entries())
      .filter(([compoundKey]) => compoundKey.startsWith(prefix))
      .map(([compoundKey, value]) => ({
        key: compoundKey.slice(prefix.length),
        value,
      })) as T[];
  }

  get<T = SqlRow>(): T | null {
    return null;
  }

  close(): void {}
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

  it("round-trips mutable security keys through persistence", () => {
    const db = new MemoryConfigurationDatabase();
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
