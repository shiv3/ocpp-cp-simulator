import { describe, expect, it } from "vitest";

import {
  cpListItemSchema,
  eventToWire,
  redactCp,
  redactSimulatorConfig,
  redactUrl,
  registryCpToWire,
  statusToWire,
  wireCpConfigSchema,
} from "../events";
import { eventEnvelopeSchema, subscribeResultSchema } from "../envelope";

const fullConfig = {
  wsUrl: "ws://user:wire-url-secret@host:9000/ocpp",
  centralSystemUrl: "https://central:wire-central-secret@csms.test/ocpp",
  soapCallbackUrl: "https://soap:wire-soap-secret@cp.test/ocpp/soap",
  ocppVersion: "OCPP-1.6J",
  connectors: 2,
  vendor: "Acme",
  model: "X1",
  basicAuth: { username: "u", password: "wire-basic-secret" },
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

const secretValues = [
  "wire-basic-secret",
  "wire-url-secret",
  "wire-central-secret",
  "wire-soap-secret",
  "wire-config-password",
  "wire-config-url-secret",
  "wire-tls-ca-material",
  "wire-tls-cert-material",
  "wire-tls-key-material",
  "wire-tls-passphrase",
  "wire-authorization-key",
];

function secretHits(value: unknown, path = "$"): string[] {
  if (typeof value === "string") {
    return secretValues
      .filter((secret) => value.includes(secret))
      .map((secret) => `${path} contains ${secret}`);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      secretHits(item, `${path}[${index}]`),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, nested]) => secretHits(nested, `${path}.${key}`),
    );
  }
  return [];
}

function passwordKeyHits(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      passwordKeyHits(item, `${path}[${index}]`),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, nested]) => [
        ...(key === "password" ? [`${path}.${key}`] : []),
        ...passwordKeyHits(nested, `${path}.${key}`),
      ],
    );
  }
  return [];
}

function expectNoSecrets(value: unknown): void {
  expect(secretHits(value)).toEqual([]);
  expect(passwordKeyHits(value)).toEqual([]);
}

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
    expect(w.centralSystemUrl).toBe("https://csms.test/ocpp");
    expect(w.soapCallbackUrl).toBe("https://cp.test/ocpp/soap");
    expect(w).toMatchObject({
      securityProfile: 3,
      cpoName: "Example CPO",
      tlsCaPath: "/etc/ocpp/ca.pem",
      tlsCertPath: "/etc/ocpp/client.pem",
      tlsKeyPath: "/etc/ocpp/client-key.pem",
    });
    expectNoSecrets(w);
  });

  it("redactCp ignores inline TLS material if a caller accidentally supplies it", () => {
    const w = redactCp({
      ...fullConfig,
      tls: {
        ca: "wire-tls-ca-material",
        cert: "wire-tls-cert-material",
        key: "wire-tls-key-material",
      },
      authorizationKey: "wire-authorization-key",
    } as typeof fullConfig);

    expectNoSecrets(w);
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
    expectNoSecrets(s);
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
    expectNoSecrets(item);
  });

  it("redactSimulatorConfig drops passwords and strips URL credentials", () => {
    const wire = redactSimulatorConfig({
      wsURL: "ws://config-user:wire-config-url-secret@host:9000/ocpp",
      ChargePointID: "CP1",
      connectorNumber: 1,
      tagID: "TAG",
      ocppVersion: "OCPP-1.6J",
      basicAuthSettings: {
        enabled: true,
        username: "config-user",
        password: "wire-config-password",
      },
      autoMeterValueSetting: {
        enabled: false,
        interval: 30,
        value: 10,
      },
      Experimental: null,
      BootNotification: {
        chargePointVendor: "Vendor",
        chargePointModel: "Model",
      },
    });

    expect(wire.wsURL).toBe("ws://host:9000/ocpp");
    expect(wire.basicAuthSettings).toEqual({
      enabled: true,
      username: "config-user",
    });
    expectNoSecrets(wire);
  });

  it("eventToWire defensively strips passwords, URL credentials, and TLS material", () => {
    const evt = eventToWire({
      event: "status_change",
      data: {
        status: "Charging",
        callbackUrl: "wss://event-user:wire-url-secret@example.test/ocpp",
        basicAuth: { username: "u", password: "wire-basic-secret" },
        tls: {
          ca: "wire-tls-ca-material",
          cert: "wire-tls-cert-material",
          key: "wire-tls-key-material",
          passphrase: "wire-tls-passphrase",
          serverName: "example.test",
        },
      },
    });

    expect(evt.data).toEqual({
      status: "Charging",
      callbackUrl: "wss://example.test/ocpp",
      basicAuth: { username: "u" },
      tls: { serverName: "example.test" },
    });
    expectNoSecrets(evt);
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
