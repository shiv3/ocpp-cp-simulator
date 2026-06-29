import { describe, expect, it } from "vitest";

import {
  cpListItemSchema,
  eventToWire,
  redactCp,
  redactUrl,
  registryCpToWire,
  statusToWire,
  wireCpConfigSchema,
} from "../events";
import { eventEnvelopeSchema, subscribeResultSchema } from "../envelope";

const fullConfig = {
  wsUrl: "ws://user:pass@host:9000/ocpp",
  ocppVersion: "OCPP-1.6J",
  connectors: 2,
  vendor: "Acme",
  model: "X1",
  basicAuth: { username: "u", password: "s3cr3t" },
  securityProfile: 3 as const,
  cpoName: "Example CPO",
  tlsCaPath: "/etc/ocpp/ca.pem",
  tlsCertPath: "/etc/ocpp/client.pem",
  tlsKeyPath: "/etc/ocpp/client-key.pem",
  bootNotification: { firmwareVersion: "1.0", iccid: "8900" },
};

const fullStatus = {
  id: "CP1",
  status: "Available",
  error: "",
  connectors: [
    {
      id: 1,
      status: "Available",
      availability: "Operative",
      meterValue: 0,
      transactionId: null,
      soc: null,
      mode: "normal",
      autoResetToAvailable: false,
      autoMeterValueConfig: null,
      evSettings: null,
      chargingProfile: null,
      chargingProfiles: [],
      transactionStartTime: null,
      transactionTagId: null,
      transactionBatteryCapacityKwh: null,
    },
  ],
  heartbeat: { intervalSeconds: 0, lastSentAt: null },
  config: fullConfig,
};

describe("redaction (Sec-2)", () => {
  it("redactUrl strips embedded credentials", () => {
    expect(redactUrl("ws://user:pass@host:9000/ocpp")).toBe(
      "ws://host:9000/ocpp",
    );
    expect(redactUrl("ws://host/ocpp")).toBe("ws://host/ocpp");
  });

  it("redactCp drops the password and strips wsUrl creds", () => {
    const w = redactCp(fullConfig);
    expect(w.basicAuth).toEqual({ username: "u" });
    expect((w.basicAuth as Record<string, unknown>).password).toBeUndefined();
    expect(w.wsUrl).toBe("ws://host:9000/ocpp");
    expect(w).toMatchObject({
      securityProfile: 3,
      cpoName: "Example CPO",
      tlsCaPath: "/etc/ocpp/ca.pem",
      tlsCertPath: "/etc/ocpp/client.pem",
      tlsKeyPath: "/etc/ocpp/client-key.pem",
    });
    expect(JSON.stringify(w)).not.toContain("s3cr3t");
  });

  it("wireCpConfigSchema is strict and rejects a password field", () => {
    const ok = wireCpConfigSchema.safeParse(redactCp(fullConfig));
    expect(ok.success).toBe(true);
    const withPw = wireCpConfigSchema.safeParse({
      ...redactCp(fullConfig),
      basicAuth: { username: "u", password: "p" },
    });
    expect(withPw.success).toBe(false);
  });

  it("statusToWire redacts the embedded config", () => {
    const s = statusToWire(fullStatus);
    expect(JSON.stringify(s)).not.toContain("s3cr3t");
    expect(s.config?.basicAuth).toEqual({ username: "u" });
    expect(s.connectors[0]?.id).toBe(1);
  });

  it("registryCpToWire builds a redacted CpListItem", () => {
    const item = registryCpToWire({
      id: "CP1",
      status: "Available",
      config: fullConfig,
    });
    expect(cpListItemSchema.safeParse(item).success).toBe(true);
    expect(item.cpId).toBe("CP1");
    expect(JSON.stringify(item)).not.toContain("s3cr3t");
  });

  it("eventToWire defensively strips any password key", () => {
    const evt = eventToWire({
      event: "status_change",
      data: {
        status: "Charging",
        basicAuth: { username: "u", password: "leak" },
      },
    });
    expect(JSON.stringify(evt)).not.toContain("leak");
  });
});

describe("envelopes", () => {
  it("eventEnvelopeSchema discriminates on kind", () => {
    expect(
      eventEnvelopeSchema.safeParse({
        kind: "cp",
        cpId: "CP1",
        evt: { event: "status_change", data: { status: "Charging" } },
      }).success,
    ).toBe(true);
    expect(
      eventEnvelopeSchema.safeParse({
        kind: "registry",
        change: "removed",
        cp: undefined,
      }).success,
    ).toBe(true);
    expect(
      eventEnvelopeSchema.safeParse({ cpId: "CP1", evt: {} }).success,
    ).toBe(false);
  });

  it("subscribeResultSchema validates a snapshot", () => {
    const r = subscribeResultSchema.safeParse({
      subscribed: ["registry"],
      snapshot: {
        cps: [
          registryCpToWire({
            id: "CP1",
            status: "Available",
            config: fullConfig,
          }),
        ],
        perCp: {},
      },
    });
    expect(r.success).toBe(true);
  });
});
