import { describe, expect, it } from "vitest";

import {
  buildOcppBasicAuthorization,
  buildOcppWebSocketConnectOptions,
  buildOcppWebSocketUrl,
  classifyBasicAuthSource,
  OcppSecurityProfileConfigError,
} from "./wsUrlWithBasic";

describe("OCPP WebSocket Basic auth", () => {
  it("keeps CLI credentials out of the WebSocket URL", () => {
    expect(
      buildOcppWebSocketUrl({
        baseUrl: "wss://csms.example.com/ocpp/",
        chargePointId: "CP001",
        basicAuth: { username: "CP001", password: "secret" },
      }),
    ).toBe("wss://csms.example.com/ocpp/CP001");
  });

  it("builds the HTTP Basic Authorization header", () => {
    expect(
      buildOcppBasicAuthorization({
        username: "CP001",
        password: "secret",
      }),
    ).toBe("Basic Q1AwMDE6c2VjcmV0");
  });

  it("derives profile 2 as wss with AuthorizationKey Basic auth and verified TLS", () => {
    const opts = buildOcppWebSocketConnectOptions({
      baseUrl: "ws://csms.example.com/ocpp/",
      chargePointId: "CP001",
      basicAuth: { username: "other", password: "must-not-send" },
      extraHeaders: {
        authorization: "Bearer caller-token",
        "X-Trace": "trace-1",
      },
      securityProfile: 2,
      authorizationKey: "AABB",
      tls: { ca: "CA PEM" },
    });

    expect(opts).toMatchObject({
      url: "wss://csms.example.com/ocpp/CP001",
      headers: {
        Authorization: "Basic Q1AwMDE6QUFCQg==",
        "X-Trace": "trace-1",
      },
      tls: { ca: "CA PEM", rejectUnauthorized: true },
    });
    expect(opts.headers.authorization).toBeUndefined();
  });

  it("requires AuthorizationKey for security profiles 1 and 2", () => {
    for (const securityProfile of [1, 2] as const) {
      expect(() =>
        buildOcppWebSocketConnectOptions({
          baseUrl: "ws://csms.example.com/ocpp/",
          chargePointId: "CP001",
          basicAuth: { username: "fallback", password: "fallback" },
          securityProfile,
        }),
      ).toThrow(OcppSecurityProfileConfigError);
    }
  });

  it("derives profile 1 Basic auth only from AuthorizationKey", () => {
    const opts = buildOcppWebSocketConnectOptions({
      baseUrl: "wss://csms.example.com/ocpp/",
      chargePointId: "CP001",
      basicAuth: { username: "fallback", password: "fallback" },
      securityProfile: 1,
      authorizationKey: "001122",
    });

    expect(opts.url).toBe("ws://csms.example.com/ocpp/CP001");
    expect(opts.headers.Authorization).toBe(
      `Basic ${Buffer.from("CP001:001122").toString("base64")}`,
    );
  });

  it("derives profile 3 as wss mTLS and strips every Authorization header", () => {
    const opts = buildOcppWebSocketConnectOptions({
      baseUrl: "ws://csms.example.com/ocpp/",
      chargePointId: "CP001",
      basicAuth: { username: "CP001", password: "secret" },
      extraHeaders: {
        Authorization: "Basic should-not-send",
        authorization: "Bearer should-not-send",
        AUTHORIZATION: "Token should-not-send",
        "X-Trace": "trace-1",
      },
      securityProfile: 3,
      authorizationKey: "AABB",
      tls: { ca: "CA PEM", cert: "CERT PEM", key: "KEY PEM" },
    });

    expect(opts).toMatchObject({
      url: "wss://csms.example.com/ocpp/CP001",
      headers: { "X-Trace": "trace-1" },
      tls: {
        ca: "CA PEM",
        cert: "CERT PEM",
        key: "KEY PEM",
        rejectUnauthorized: true,
      },
    });
    expect(
      Object.keys(opts.headers).some(
        (key) => key.toLowerCase() === "authorization",
      ),
    ).toBe(false);
  });

  it("warns only when TLS verification is explicitly disabled", () => {
    const warnings: string[] = [];

    const opts = buildOcppWebSocketConnectOptions({
      baseUrl: "wss://csms.example.com/ocpp/",
      chargePointId: "CP001",
      basicAuth: null,
      securityProfile: 2,
      authorizationKey: "AABB",
      tls: { rejectUnauthorized: false },
      warn: (message) => warnings.push(message),
    });

    expect(opts.tls?.rejectUnauthorized).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("verification is disabled");
  });

  it("falls back to a query param for browser WebSocket clients", () => {
    const runtime = globalThis as { document?: unknown };
    const previousDocument = runtime.document;
    runtime.document = {};

    try {
      expect(
        buildOcppWebSocketUrl({
          baseUrl: "wss://csms.example.com/ocpp/",
          chargePointId: "CP001",
          basicAuth: { username: "CP001", password: "secret" },
        }),
      ).toBe("wss://csms.example.com/ocpp/CP001?ocpp_ws_secret=secret");
    } finally {
      if (previousDocument === undefined) {
        delete runtime.document;
      } else {
        runtime.document = previousDocument;
      }
    }
  });
});

// #178 item F: consolidating the duplicate Basic Auth settings (legacy
// Optional-Settings toggle vs. 1.6+ Security Profile) into a single
// resolver. classifyBasicAuthSource is the shape-only classification the
// UI uses to decide what to tell the operator; resolveBasicAuth (exercised
// indirectly via buildOcppWebSocketConnectOptions below) is the same
// precedence applied to actually build connection credentials.
describe("classifyBasicAuthSource (#178 item F)", () => {
  it("prefers the Security Profile once explicitly configured (1 or 2)", () => {
    expect(
      classifyBasicAuthSource({
        securityProfile: 1,
        legacyBasicAuthEnabled: true,
      }),
    ).toBe("security-profile");
    expect(
      classifyBasicAuthSource({
        securityProfile: 2,
        legacyBasicAuthEnabled: true,
      }),
    ).toBe("security-profile");
  });

  it("reports no Basic Auth under mutual TLS (profile 3), even if the legacy toggle is still set", () => {
    expect(
      classifyBasicAuthSource({
        securityProfile: 3,
        legacyBasicAuthEnabled: true,
      }),
    ).toBe("none");
  });

  it("falls back to the legacy toggle when no Security Profile has ever been set (backward compat)", () => {
    expect(
      classifyBasicAuthSource({
        securityProfile: undefined,
        legacyBasicAuthEnabled: true,
      }),
    ).toBe("legacy");
  });

  it("falls back to the legacy toggle at the explicit default profile 0", () => {
    expect(
      classifyBasicAuthSource({
        securityProfile: 0,
        legacyBasicAuthEnabled: true,
      }),
    ).toBe("legacy");
  });

  it("reports none when neither mechanism is configured", () => {
    expect(
      classifyBasicAuthSource({
        securityProfile: undefined,
        legacyBasicAuthEnabled: false,
      }),
    ).toBe("none");
    expect(
      classifyBasicAuthSource({
        securityProfile: 0,
        legacyBasicAuthEnabled: false,
      }),
    ).toBe("none");
  });
});

describe("#178 item F — backward-compat migration at connect time", () => {
  it("a charge point saved before Security Profiles existed (securityProfile undefined) still authenticates with its legacy credentials", () => {
    const opts = buildOcppWebSocketConnectOptions({
      baseUrl: "wss://csms.example.com/ocpp/",
      chargePointId: "CP001",
      basicAuth: { username: "legacy-user", password: "legacy-pass" },
      securityProfile: undefined,
      authorizationKey: undefined,
    });

    expect(opts.headers.Authorization).toBe(
      buildOcppBasicAuthorization({
        username: "legacy-user",
        password: "legacy-pass",
      }),
    );
  });

  it("a charge point explicitly saved at the default profile 0 with legacy Basic Auth still authenticates unchanged", () => {
    const opts = buildOcppWebSocketConnectOptions({
      baseUrl: "wss://csms.example.com/ocpp/",
      chargePointId: "CP001",
      basicAuth: { username: "legacy-user", password: "legacy-pass" },
      securityProfile: 0,
    });

    expect(opts.headers.Authorization).toBe(
      buildOcppBasicAuthorization({
        username: "legacy-user",
        password: "legacy-pass",
      }),
    );
  });

  it("does NOT silently drop legacy credentials by auto-promoting to profile 1 (would force username to the CP id)", () => {
    const opts = buildOcppWebSocketConnectOptions({
      baseUrl: "wss://csms.example.com/ocpp/",
      chargePointId: "CP001",
      basicAuth: { username: "legacy-user", password: "legacy-pass" },
      securityProfile: 0,
    });

    // The legacy username is preserved verbatim — a security-profile-1
    // resolution would have forced it to "CP001" instead.
    expect(opts.headers.Authorization).not.toBe(
      buildOcppBasicAuthorization({
        username: "CP001",
        password: "legacy-pass",
      }),
    );
  });
});
