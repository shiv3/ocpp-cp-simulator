import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  labelKeySchema,
  labelValueSchema,
} from "@ocpp-cp-simulator/contracts/labels";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

// Each call starts a bun process (hundreds of ms, seconds under a loaded full
// run). Make ONE call per test (#473, #783): a test with several calls spends
// several start-ups against the default 5 s timeout. Use it.each for cases.
function runParseArgs(args: string[]) {
  const script = [
    'import { buildBootstrap, parseArgs } from "./apps/cli/src/main.ts";',
    'import { buildOcppWebSocketConnectOptions } from "./packages/core/src/cp/infrastructure/transport/wsUrlWithBasic.ts";',
    `const options = parseArgs(["bun", "apps/cli/src/main.ts", ...${JSON.stringify(
      args,
    )}]);`,
    "const openOptions = options.cpId ? buildOcppWebSocketConnectOptions({",
    "  baseUrl: options.wsUrl,",
    "  chargePointId: options.cpId,",
    "  basicAuth: options.basicAuth,",
    "  extraHeaders: options.extraWsHeaders,",
    "  extraSubprotocols: options.extraWsSubprotocols,",
    "  ocppVersion: options.ocppVersion,",
    "  securityProfile: options.securityProfile,",
    "  authorizationKey: options.authorizationKey,",
    "  tls: options.tls,",
    "}) : null;",
    "console.log(JSON.stringify({",
    "  ocppVersion: options.ocppVersion ?? null,",
    "  securityProfile: options.securityProfile ?? null,",
    "  authorizationKey: options.authorizationKey ?? null,",
    "  cpoName: options.cpoName ?? null,",
    "  tls: options.tls ?? null,",
    "  tlsCaPath: options.tlsCaPath ?? null,",
    "  tlsCertPath: options.tlsCertPath ?? null,",
    "  tlsKeyPath: options.tlsKeyPath ?? null,",
    "  insecureTlsKeyPerms: options.insecureTlsKeyPerms,",
    "  openOptions,",
    "  daemon: options.daemon,",
    "  httpHost: options.httpHost,",
    "  httpPort: options.httpPort,",
    "  unixSocket: options.unixSocket,",
    "  unsafeRemote: options.unsafeRemote,",
    "  soapCallbackUrl: options.soapCallbackUrl,",
    "  soapPath: options.soapPath,",
    "  soapTunnel: options.soapTunnel,",
    "  hasWebConsoleBasicAuth: options.webConsoleBasicAuth !== null,",
    "  traceOutput: options.traceOutput,",
    "  watch: options.watch,",
    "  oedBaseUrl: options.oedBaseUrl,",
    "  oedApiKeyFile: options.oedApiKeyFile,",
    "  fleetTemplateFiles: options.fleetTemplateFiles,",
    "  bootstrapPacing: options.bootstrapPacing ?? null,",
    "  labels: options.labels ?? null,",
    "  bootstrapLabels: buildBootstrap(options)?.labels ?? null,",
    "  transport: options.transport ?? null,",
    "  txUpdatedMeterValues: options.txUpdatedMeterValues ?? null,",
    "  bootstrapTxUpdatedMeterValues:",
    "    buildBootstrap(options)?.txUpdatedMeterValues ?? null,",
    "  inboundValidation: options.inboundValidation ?? null,",
    "  bootstrapInboundValidation:",
    "    buildBootstrap(options)?.inboundValidation ?? null,",
    "  reservationAuthorizeIdTag: options.reservationAuthorizeIdTag ?? null,",
    "  bootstrapReservationAuthorizeIdTag:",
    "    buildBootstrap(options)?.reservationAuthorizeIdTag ?? null,",
    "  ops: {",
    "    allowedHosts: options.allowedHosts, trustedProxies: options.trustedProxies,",
    "    requireTls: options.requireTls, rateLimitPerIp: options.rateLimitPerIp,",
    "    rateLimitMaxIps: options.rateLimitMaxIps, logLevel: options.logLevel,",
    "    logFile: options.logFile, logMaxBytes: options.logMaxBytes,",
    "    logRotateDaily: options.logRotateDaily, logKeep: options.logKeep,",
    "    shutdownStopTransactions: options.shutdownStopTransactions,",
    "    shutdownWaitMs: options.shutdownWaitMs,",
    "    connectRestored: options.connectRestored, cpBulkWaitMs: options.cpBulkWaitMs,",
    "  },",
    "}));",
  ].join("\n");

  return spawnSync("bun", ["--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("parseArgs --watch (#314)", () => {
  it("is off unless asked for", () => {
    const result = runParseArgs([
      "--daemon",
      "--cp-id",
      "CP-W",
      "--ws-url",
      "ws://csms.example.test/ocpp/",
    ]);

    expect(result.status).toBe(0);
    // Opt-in by construction: a daemon that silently re-reads files under the
    // operator is surprising, and the RPC workflows have nothing on disk.
    expect(JSON.parse(result.stdout).watch).toBe(false);
  });

  it("turns file hot-reload on", () => {
    const result = runParseArgs([
      "--daemon",
      "--watch",
      "--cp-id",
      "CP-W",
      "--ws-url",
      "ws://csms.example.test/ocpp/",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).watch).toBe(true);
  });

  it("refuses --watch outside a server mode instead of ignoring it", () => {
    // The file watcher lives in the daemon. Without this the flag parses,
    // the process runs a single standalone CP, and nothing is ever watched --
    // the same silent-no-op #295's review rejected for --cp-count.
    const result = runParseArgs([
      "--watch",
      "--cp-id",
      "CP-W",
      "--ws-url",
      "ws://csms.example.test/ocpp/",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--watch needs a server mode");
  });

  it("refuses --watch alongside a client mode even when a server flag is present", () => {
    // The hole in the first version of this guard: `--http-port` makes
    // `isServerMode` true, but with `--events` the process returns through the
    // client path before any server starts — and there `--http-port` names the
    // daemon to talk to, not a port to listen on. The flag parsed, passed the
    // guard, and was silently ignored, which is the exact failure the guard
    // exists to prevent.
    const result = runParseArgs([
      "--events",
      "--all",
      "--http-port",
      "9000",
      "--watch",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "--watch cannot be combined with a client mode",
    );
  });

  it("still refuses --watch with a client mode and no server flag", () => {
    const result = runParseArgs(["--stop", "--watch"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "--watch cannot be combined with a client mode",
    );
  });

  it("refuses two startup scenario options and names both", () => {
    // #314: the three functions that derive from these flags each ranked them
    // differently, so a combination did not merely pick one — the load and the
    // prediction of the load picked *different* ones, and the restore held rows
    // back for a scenario that was never loaded. Refused at parse time, so the
    // daemon does not reach the readers at all.
    const result = runParseArgs([
      "--cp-id",
      "CP-S",
      "--ws-url",
      "ws://csms.example.test/ocpp/",
      "--scenario",
      "/tmp/s.json",
      "--scenario-template",
      "essential-cp-behavior",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--scenario-template, --scenario");
    expect(result.stderr).toContain("cannot be combined");
  });

  it("accepts a single startup scenario option", () => {
    // The other half of the guard: one flag is not a conflict. Without this the
    // check could be inverted, or made unconditional, and nothing would say so.
    const result = runParseArgs([
      "--cp-id",
      "CP-S",
      "--ws-url",
      "ws://csms.example.test/ocpp/",
      "--scenario-template",
      "essential-cp-behavior",
    ]);

    expect(result.status).toBe(0);
  });
});

describe("parseArgs OCPP 1.6 security flags", () => {
  it("parses security profile, AuthorizationKey, and CPO name", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-SEC",
      "--ws-url",
      "ws://csms.example.test/ocpp/",
      "--security-profile",
      "2",
      "--authorization-key",
      "AABBcc01",
      "--cpo-name",
      "Example CPO",
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      securityProfile: 2,
      authorizationKey: "AABBcc01",
      cpoName: "Example CPO",
    });
    expect(parsed.openOptions).toMatchObject({
      url: "wss://csms.example.test/ocpp/CP-SEC",
      headers: {
        Authorization: `Basic ${Buffer.from("CP-SEC:AABBcc01").toString(
          "base64",
        )}`,
      },
      tls: { rejectUnauthorized: true },
    });
  });

  const INBOUND_BASE = [
    "--cp-id",
    "CP-593",
    "--ws-url",
    "ws://csms.example.test/ocpp/",
  ];

  it("--inbound-validation sets the #593 mode for the bootstrap charge point", () => {
    const enforce = runParseArgs([
      ...INBOUND_BASE,
      "--inbound-validation",
      "enforce",
    ]);
    expect(enforce.status).toBe(0);
    expect(JSON.parse(enforce.stdout)).toMatchObject({
      inboundValidation: "enforce",
      bootstrapInboundValidation: "enforce",
    });
  });

  it("leaves --inbound-validation unset by default (#593)", () => {
    const unset = runParseArgs(INBOUND_BASE);
    expect(JSON.parse(unset.stdout)).toMatchObject({
      inboundValidation: null,
      bootstrapInboundValidation: null,
    });
  });

  it("refuses an unknown --inbound-validation mode (#593)", () => {
    const bad = runParseArgs([
      ...INBOUND_BASE,
      "--inbound-validation",
      "strict",
    ]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("--inbound-validation must be");
  });

  // One runParseArgs per test (#783): an "on" and an "off" case in one test
  // is the shape that timed out.
  const RESERVATION_BASE = [
    "--cp-id",
    "CP-595",
    "--ws-url",
    "ws://csms.example.test/ocpp/",
  ];

  it("--reservation-authorize-id-tag turns the #595 option on for the bootstrap charge point", () => {
    const on = runParseArgs([
      ...RESERVATION_BASE,
      "--reservation-authorize-id-tag",
    ]);
    expect(on.status).toBe(0);
    expect(JSON.parse(on.stdout)).toMatchObject({
      reservationAuthorizeIdTag: true,
      bootstrapReservationAuthorizeIdTag: true,
    });
  });

  it("--reservation-authorize-id-tag stays off by default (#595)", () => {
    const off = runParseArgs(RESERVATION_BASE);
    expect(off.status).toBe(0);
    expect(JSON.parse(off.stdout)).toMatchObject({
      reservationAuthorizeIdTag: null,
      bootstrapReservationAuthorizeIdTag: null,
    });
  });

  it("--tx-updated-meter-values turns the #347 option on for the bootstrap charge point", () => {
    const on = runParseArgs([
      "--cp-id",
      "CP-347",
      "--ws-url",
      "ws://csms.example.test/ocpp/",
      "--ocpp-version",
      "OCPP-2.0.1",
      "--tx-updated-meter-values",
    ]);
    expect(on.status).toBe(0);
    expect(JSON.parse(on.stdout)).toMatchObject({
      txUpdatedMeterValues: true,
      bootstrapTxUpdatedMeterValues: true,
    });
  });

  it("--tx-updated-meter-values stays off by default (#347)", () => {
    const off = runParseArgs([
      "--cp-id",
      "CP-347",
      "--ws-url",
      "ws://csms.example.test/ocpp/",
    ]);
    expect(off.status).toBe(0);
    expect(JSON.parse(off.stdout)).toMatchObject({
      txUpdatedMeterValues: null,
      bootstrapTxUpdatedMeterValues: null,
    });
  });

  it("reads TLS PEM files and threads them into WS connect options", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ocpp-tls-flags-"));
    const ca = resolve(dir, "ca.pem");
    const cert = resolve(dir, "client.pem");
    const key = resolve(dir, "client-key.pem");
    writeFileSync(
      ca,
      "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
    );
    writeFileSync(
      cert,
      "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n",
    );
    writeFileSync(
      key,
      "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n",
    );
    chmodSync(key, 0o600);

    try {
      const result = runParseArgs([
        "--cp-id",
        "CP-MTLS",
        "--ws-url",
        "ws://csms.example.test/ocpp/",
        "--security-profile",
        "3",
        "--tls-ca",
        ca,
        "--tls-cert",
        cert,
        "--tls-key",
        key,
      ]);

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.tls).toMatchObject({
        ca: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
        cert: "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n",
        key: "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n",
      });
      expect(parsed).toMatchObject({
        tlsCaPath: ca,
        tlsCertPath: cert,
        tlsKeyPath: key,
        insecureTlsKeyPerms: false,
      });
      expect(parsed.openOptions).toMatchObject({
        url: "wss://csms.example.test/ocpp/CP-MTLS",
        headers: {},
        tls: {
          ca: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
          cert: "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n",
          key: "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n",
          rejectUnauthorized: true,
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects group/other-readable TLS private keys by default", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ocpp-tls-key-perms-"));
    const key = resolve(dir, "client-key.pem");
    writeFileSync(
      key,
      "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n",
    );
    chmodSync(key, 0o644);

    try {
      const result = runParseArgs([
        "--cp-id",
        "CP-MTLS",
        "--ws-url",
        "ws://csms.example.test/ocpp/",
        "--security-profile",
        "3",
        "--tls-key",
        key,
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("expected mode 0600");
      expect(result.stderr).toContain("--insecure-tls-key-perms");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows permissive TLS private keys only with an explicit override", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ocpp-tls-key-perms-"));
    const key = resolve(dir, "client-key.pem");
    writeFileSync(
      key,
      "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n",
    );
    chmodSync(key, 0o644);

    try {
      const result = runParseArgs([
        "--cp-id",
        "CP-MTLS",
        "--ws-url",
        "ws://csms.example.test/ocpp/",
        "--security-profile",
        "3",
        "--tls-key",
        key,
        "--insecure-tls-key-perms",
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("expected mode 0600");
      expect(result.stderr).toContain(
        "proceeding because --insecure-tls-key-perms was passed",
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        insecureTlsKeyPerms: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips caller Authorization headers for profile 3", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-MTLS",
      "--ws-url",
      "ws://csms.example.test/ocpp/",
      "--security-profile",
      "3",
      "--header",
      "authorization:Bearer caller-token",
      "--header",
      "X-Trace:trace-1",
    ]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.openOptions.headers).toEqual({ "X-Trace": "trace-1" });
  });

  const WS_BASE = ["--cp-id", "CP-1", "--ws-url", "ws://127.0.0.1:9000/ocpp"];

  it("has no transport options unless a reconnect or --ws-* flag is given (#609)", () => {
    const none = JSON.parse(runParseArgs(WS_BASE).stdout);
    expect(none.transport).toBeNull();
  });

  it("collects the reconnect flags into transport.reconnect (#609)", () => {
    const result = runParseArgs([
      ...WS_BASE,
      "--reconnect-max-attempts",
      "5",
      "--reconnect-mode",
      "fixed",
      "--reconnect-base-delay-ms",
      "250",
      "--reconnect-max-delay-ms",
      "2000",
      "--reconnect-jitter-ms",
      "50",
      "--boot-retry-limit",
      "-1",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).transport).toEqual({
      reconnect: {
        maxAttempts: 5,
        mode: "fixed",
        baseDelayMs: 250,
        maxDelayMs: 2000,
        jitterMs: 50,
        bootRetryLimit: -1,
      },
    });
  });

  it("collects --ws-* flags into transport.ws (#611)", () => {
    const ok = runParseArgs([
      ...WS_BASE,
      "--ws-handshake-timeout-ms",
      "4000",
      "--ws-no-compression",
      "--ws-proxy",
      "http://proxy.example:3128",
    ]);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).transport).toEqual({
      ws: {
        handshakeTimeoutMs: 4000,
        perMessageDeflate: false,
        proxy: "http://proxy.example:3128",
      },
    });
  });

  it.each([
    [["--ws-max-payload", "1024"], '"maxPayloadBytes" is not supported on bun'],
    [
      ["--ws-local-address", "10.0.0.5"],
      '"localAddress" is not supported on bun',
    ],
    [["--ws-proxy", "socks5://p:1"], "ws.proxy"],
  ])("refuses %j, which Bun ignores (#611)", (flags, message) => {
    const result = runParseArgs([...WS_BASE, ...flags]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("refuses --ws-* flags on a SOAP version (#611)", () => {
    const soap = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "http://127.0.0.1:9000/cs",
      "--ocpp-version",
      "OCPP-1.6S",
      "--soap-callback-url",
      "http://127.0.0.1:9100/cb",
      "--ws-no-compression",
    ]);
    expect(soap.status).toBe(1);
    expect(soap.stderr).toContain("SOAP versions have none");
  });

  it.each([
    [["--reconnect-mode", "linear"], "--reconnect-mode must be"],
    [["--reconnect-max-attempts", "-2"], "--reconnect-max-attempts must be"],
    [["--reconnect-max-attempts", "1.5"], "an integer"],
    [["--reconnect-jitter-ms", "abc"], "--reconnect-jitter-ms must be"],
    [
      ["--reconnect-base-delay-ms", "5000", "--reconnect-max-delay-ms", "1000"],
      "maxDelayMs must be >= baseDelayMs",
    ],
  ])("rejects bad reconnect flags %j (#609)", (flags, message) => {
    const result = runParseArgs([...WS_BASE, ...flags]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("rejects invalid security profiles", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "ws://127.0.0.1:9000/ocpp",
      "--security-profile",
      "4",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Error: --security-profile must be one of 0, 1, 2, 3",
    );
  });
});

describe("parseArgs --ocpp-version", () => {
  it("accepts OCPP-1.2", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "ws://127.0.0.1:9000/ocpp",
      "--ocpp-version",
      "OCPP-1.2",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ocppVersion: "OCPP-1.2",
    });
  });

  it("accepts OCPP-1.5", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "ws://127.0.0.1:9000/ocpp",
      "--ocpp-version",
      "OCPP-1.5",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ocppVersion: "OCPP-1.5",
    });
  });

  it("accepts OCPP-1.6S", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "ws://127.0.0.1:9000/ocpp",
      "--ocpp-version",
      "OCPP-1.6S",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ocppVersion: "OCPP-1.6S",
    });
  });

  it("accepts OCPP-2.0.1", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "ws://127.0.0.1:9000/ocpp",
      "--ocpp-version",
      "OCPP-2.0.1",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ocppVersion: "OCPP-2.0.1",
    });
  });

  it("leaves ocppVersion undefined when omitted", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "ws://127.0.0.1:9000/ocpp",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ocppVersion: null });
  });

  it("parses OCPP 1.5 SOAP callback flags", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "http://127.0.0.1:8180/steve/services/CentralSystemService",
      "--ocpp-version",
      "OCPP-1.5",
      "--soap-callback-url",
      "http://127.0.0.1:9700/ocpp/soap/CP-1/ChargePointService",
      "--soap-path",
      "/ocpp/soap",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ocppVersion: "OCPP-1.5",
      soapCallbackUrl:
        "http://127.0.0.1:9700/ocpp/soap/CP-1/ChargePointService",
      soapPath: "/ocpp/soap",
    });
  });

  it("derives the SOAP callback URL from --soap-public-base-url", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "http://127.0.0.1:8180/steve/services/CentralSystemService",
      "--ocpp-version",
      "OCPP-1.6S",
      "--soap-public-base-url",
      "https://abcd.ngrok-free.app",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ocppVersion: "OCPP-1.6S",
      soapCallbackUrl:
        "https://abcd.ngrok-free.app/ocpp/soap/CP-1/ChargePointService",
    });
    expect(result.stderr).toContain(
      "SOAP callback URL resolved from --soap-public-base-url",
    );
  });

  it("lets an explicit --soap-callback-url win over --soap-public-base-url", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "http://127.0.0.1:8180/steve/services/CentralSystemService",
      "--ocpp-version",
      "OCPP-1.6S",
      "--soap-callback-url",
      "http://explicit.test/ocpp/soap/CP-1/ChargePointService",
      "--soap-public-base-url",
      "https://abcd.ngrok-free.app",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      soapCallbackUrl: "http://explicit.test/ocpp/soap/CP-1/ChargePointService",
    });
  });

  it("rejects a non-http(s) --soap-public-base-url", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "http://127.0.0.1:8180/steve/services/CentralSystemService",
      "--ocpp-version",
      "OCPP-1.6S",
      "--soap-public-base-url",
      "ws://abcd.ngrok-free.app",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Error: --soap-public-base-url must be an absolute http(s) URL",
    );
  });

  describe("--soap-tunnel ngrok (#183)", () => {
    const soapDaemon = [
      "--daemon",
      "--cp-id",
      "CP-1",
      "--ws-url",
      "http://127.0.0.1:8180/steve/services/CentralSystemService",
      "--ocpp-version",
      "OCPP-1.6S",
    ];

    it("does not require Basic Auth or --unsafe-remote: the tunnel publishes the callback route alone", () => {
      const result = runParseArgs([...soapDaemon, "--soap-tunnel", "ngrok"]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        soapTunnel: { provider: "ngrok", localPort: 0 },
        hasWebConsoleBasicAuth: false,
        unsafeRemote: false,
      });
    });

    // One case per test: each runParseArgs spawns a bun process, and several
    // in a row outlast the 5 s timeout under a loaded full run (#473).
    it("accepts --soap-tunnel-port", () => {
      const withPort = runParseArgs([
        ...soapDaemon,
        "--soap-tunnel",
        "ngrok",
        "--soap-tunnel-port",
        "9702",
      ]);
      expect(withPort.status).toBe(0);
      expect(JSON.parse(withPort.stdout)).toMatchObject({
        soapTunnel: { localPort: 9702 },
      });
    });

    it("requires --soap-tunnel-port in attach mode", () => {
      const attachWithout = runParseArgs([
        ...soapDaemon,
        "--soap-tunnel",
        "ngrok",
        "--ngrok-api-url",
        "http://ngrok:4040",
      ]);
      expect(attachWithout.status).toBe(1);
      expect(attachWithout.stderr).toContain(
        "--ngrok-api-url requires --soap-tunnel-port",
      );
    });

    it("rejects --soap-tunnel-port without --soap-tunnel ngrok", () => {
      const stray = runParseArgs([...soapDaemon, "--soap-tunnel-port", "9702"]);
      expect(stray.status).toBe(1);
      expect(stray.stderr).toContain(
        "--soap-tunnel-port requires --soap-tunnel ngrok",
      );
    });

    it.each(["70000", "9702abc", "1e3", "-1"])(
      "rejects --soap-tunnel-port %s",
      (value) => {
        const bad = runParseArgs([
          ...soapDaemon,
          "--soap-tunnel",
          "ngrok",
          "--soap-tunnel-port",
          value,
        ]);
        expect(bad.status).toBe(1);
        expect(bad.stderr).toContain(
          "--soap-tunnel-port must be a port number",
        );
      },
    );

    it("defaults to no tunnel", () => {
      const result = runParseArgs(soapDaemon);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ soapTunnel: null });
    });

    it("accepts the ngrok provider with its options in server mode", () => {
      const result = runParseArgs([
        ...soapDaemon,
        "--soap-tunnel",
        "ngrok",
        "--ngrok-auth-token",
        "tok-123",
        "--ngrok-domain",
        "cp.example.ngrok.app",
      ]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        soapTunnel: {
          provider: "ngrok",
          authToken: "tok-123",
          domain: "cp.example.ngrok.app",
          apiUrl: null,
        },
        // Resolved later, once the tunnel is up.
        soapCallbackUrl: null,
      });
      expect(result.stderr).not.toContain("tok-123");
    });

    it("accepts attach mode through --ngrok-api-url", () => {
      const result = runParseArgs([
        ...soapDaemon,
        "--soap-tunnel",
        "ngrok",
        "--ngrok-api-url",
        "http://ngrok:4040",
        "--soap-tunnel-port",
        "9702",
      ]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        soapTunnel: {
          provider: "ngrok",
          apiUrl: "http://ngrok:4040",
          localPort: 9702,
        },
      });
    });

    it("rejects an unknown provider", () => {
      const result = runParseArgs([
        ...soapDaemon,
        "--soap-tunnel",
        "cloudflare",
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Error: --soap-tunnel must be one of: none, ngrok",
      );
    });

    it("rejects a non-http(s) --ngrok-api-url", () => {
      const result = runParseArgs([
        ...soapDaemon,
        "--soap-tunnel",
        "ngrok",
        "--ngrok-api-url",
        "ngrok:4040",
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Error: --ngrok-api-url must be an absolute http(s) URL",
      );
    });

    it("rejects --ngrok-* options without --soap-tunnel ngrok", () => {
      const result = runParseArgs([
        ...soapDaemon,
        "--ngrok-domain",
        "cp.example.ngrok.app",
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Error: --ngrok-domain requires --soap-tunnel ngrok",
      );
    });

    it("rejects agent options in attach mode", () => {
      const result = runParseArgs([
        ...soapDaemon,
        "--soap-tunnel",
        "ngrok",
        "--ngrok-api-url",
        "http://ngrok:4040",
        "--ngrok-auth-token",
        "tok-123",
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Error: --ngrok-auth-token and --ngrok-domain cannot be combined with --ngrok-api-url",
      );
      expect(result.stderr).not.toContain("tok-123");
    });

    it("rejects a tunnel for a non-SOAP OCPP version", () => {
      const result = runParseArgs([
        "--daemon",
        "--cp-id",
        "CP-1",
        "--ws-url",
        "ws://csms.example.test/ocpp/",
        "--ocpp-version",
        "OCPP-1.6J",
        "--soap-tunnel",
        "ngrok",
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Error: --soap-tunnel requires a SOAP --ocpp-version (OCPP-1.2, OCPP-1.5 or OCPP-1.6S)",
      );
    });

    it("rejects a tunnel outside server mode", () => {
      const result = runParseArgs([
        "--cp-id",
        "CP-1",
        "--ws-url",
        "http://127.0.0.1:8180/steve/services/CentralSystemService",
        "--ocpp-version",
        "OCPP-1.6S",
        "--soap-tunnel",
        "ngrok",
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Error: --soap-tunnel requires server mode (--daemon, --http-port or --web-console)",
      );
    });

    it("refuses a tunnel together with an explicit public base URL", () => {
      const result = runParseArgs([
        ...soapDaemon,
        "--soap-tunnel",
        "ngrok",
        "--soap-public-base-url",
        "https://abcd.ngrok-free.app",
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Error: --soap-tunnel cannot be combined with --soap-public-base-url",
      );
    });

    it("refuses a tunnel together with an explicit callback URL", () => {
      const result = runParseArgs([
        ...soapDaemon,
        "--soap-tunnel",
        "ngrok",
        "--soap-callback-url",
        "https://explicit.test/ocpp/soap/CP-1/ChargePointService",
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Error: --soap-tunnel cannot be combined with --soap-callback-url",
      );
    });
  });

  it("rejects unsupported versions", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "ws://127.0.0.1:9000/ocpp",
      "--ocpp-version",
      "OCPP-1.6",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Error: --ocpp-version must be one of OCPP-1.2, OCPP-1.5, OCPP-1.6J, OCPP-1.6S, OCPP-2.0.1, OCPP-2.1",
    );
  });
});

describe("parseArgs socket.io daemon migration flags", () => {
  it("defaults bare --daemon to 127.0.0.1:9700", () => {
    const result = runParseArgs(["--daemon"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      daemon: true,
      httpHost: "127.0.0.1",
      httpPort: 9700,
      unixSocket: null,
    });
  });

  it("accepts --unix-socket as a deprecated no-op", () => {
    const result = runParseArgs(["--daemon", "--unix-socket", "/tmp/old.sock"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("--unix-socket is deprecated and ignored");
    expect(JSON.parse(result.stdout)).toMatchObject({
      httpPort: 9700,
      unixSocket: null,
    });
  });

  it("parses --unsafe-remote", () => {
    const result = runParseArgs([
      "--daemon",
      "--http-host",
      "0.0.0.0",
      "--unsafe-remote",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      httpHost: "0.0.0.0",
      httpPort: 9700,
      unsafeRemote: true,
    });
  });

  it("rejects non-loopback daemon binds without web-console auth or --unsafe-remote", () => {
    const result = runParseArgs(["--daemon", "--http-host", "0.0.0.0"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to bind unauthenticated daemon");
    expect(result.stderr).toContain("--web-console-basic-auth-user");
    expect(result.stderr).toContain("--unsafe-remote");
  });

  it("allows non-loopback daemon binds with web-console basic auth", () => {
    const result = runParseArgs([
      "--daemon",
      "--http-host",
      "0.0.0.0",
      "--web-console-basic-auth-user",
      "operator",
      "--web-console-basic-auth-pass",
      "secret",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      httpHost: "0.0.0.0",
      httpPort: 9700,
      hasWebConsoleBasicAuth: true,
      unsafeRemote: false,
    });
  });
});

describe("parseArgs --trace-output", () => {
  it("lands the path in options.traceOutput", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "ws://127.0.0.1:9000/ocpp",
      "--trace-output",
      "trace.jsonl",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      traceOutput: "trace.jsonl",
    });
  });

  it("defaults to null when omitted", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "ws://127.0.0.1:9000/ocpp",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ traceOutput: null });
  });

  it("exits with an error when given no path", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP-1",
      "--ws-url",
      "ws://127.0.0.1:9000/ocpp",
      "--trace-output",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Error: --trace-output requires a file path",
    );
  });
});

describe("parseArgs Open EV Directory flags (#458)", () => {
  it("reads --oed-base-url and --oed-api-key-file", () => {
    const result = runParseArgs([
      "--daemon",
      "--oed-base-url",
      "https://evd.example.test",
      "--oed-api-key-file",
      "/run/secrets/oed",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      oedBaseUrl: "https://evd.example.test",
      oedApiKeyFile: "/run/secrets/oed",
    });
  });

  it("defaults both to null", () => {
    const result = runParseArgs(["--daemon"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      oedBaseUrl: null,
      oedApiKeyFile: null,
    });
  });

  it("accepts none to turn vehicle import off", () => {
    const result = runParseArgs(["--daemon", "--oed-base-url", "none"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ oedBaseUrl: "none" });
  });

  it("refuses a base URL that is not http(s)", () => {
    const result = runParseArgs(["--daemon", "--oed-base-url", "evd.example"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--oed-base-url must be an absolute http(s) URL or none",
    );
  });

  it("has no flag that takes the key itself", () => {
    const result = runParseArgs(["--daemon", "--oed-api-key", "evd_live_x"]);
    expect(result.status).not.toBe(0);
  });
});

describe("parseArgs --label (#472)", () => {
  const DAEMON = [
    "--daemon",
    "--cp-id",
    "CP",
    "--ws-url",
    "ws://csms.example.test/ocpp/",
  ];

  it("has no labels unless asked for", () => {
    const result = runParseArgs(DAEMON);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).labels).toBeNull();
  });

  it("collects every repeated --label into one map", () => {
    const result = runParseArgs([
      ...DAEMON,
      "--label",
      "site=a",
      "--label",
      "env=lab",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).labels).toEqual({
      site: "a",
      env: "lab",
    });
  });

  it("puts the labels on the bootstrap the daemon expands into its fleet", () => {
    // `expandBootstrap` copies the bootstrap onto every `--cp-count` charge
    // point, so this is the one hand-off the flag needs to reach the fleet.
    const result = runParseArgs([
      ...DAEMON,
      "--cp-count",
      "3",
      "--label",
      "site=a",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).bootstrapLabels).toEqual({ site: "a" });
  });

  it("splits on the first '=' only, so a value keeps its '=' and ','", () => {
    // `=` cannot appear in a key, so the first one is the separator and
    // everything after it is the value, verbatim.
    const result = runParseArgs([...DAEMON, "--label", "note=a=b,c"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).labels).toEqual({ note: "a=b,c" });
  });

  it("accepts an empty value", () => {
    const result = runParseArgs([...DAEMON, "--label", "flag="]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).labels).toEqual({ flag: "" });
  });

  it.each([
    [["--label"], "--label requires KEY=VALUE"],
    [["--label", "--watch"], "--label requires KEY=VALUE"],
    [["--label", "site"], "--label value must be KEY=VALUE, got 'site'"],
    [["--label", "=a"], "--label value must be KEY=VALUE, got '=a'"],
    [
      ["--label", "site=a", "--label", "site=b"],
      "--label key 'site' given twice",
    ],
  ])("refuses %j", (args, message) => {
    const result = runParseArgs([...DAEMON, ...args]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Error: ${message}`);
  });

  it.each([
    ["a key with a space", "bad key=x", "--label key 'bad key' is invalid"],
    ["a key starting with a separator", "-x=1", "--label key '-x' is invalid"],
    // The record schema strips this key without an issue, so a check on the
    // whole map alone would let it vanish instead of refusing it.
    ["the __proto__ key", "__proto__=x", "--label key '__proto__' is invalid"],
    [
      "a key longer than 63 characters",
      `${"k".repeat(64)}=x`,
      `--label key '${"k".repeat(64)}' is invalid`,
    ],
    [
      "a value longer than 256 characters",
      `k=${"v".repeat(257)}`,
      "--label value for 'k' is invalid",
    ],
  ])("refuses %s with the schema's reason", (_case, pair, message) => {
    // The per-pair message, not just the `--label` prefix: the whole-map
    // check would also refuse most of these, and would hide a lost per-pair
    // check behind a vaguer reason.
    const result = runParseArgs([...DAEMON, "--label", pair]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Error: ${message}`);
    // …and the rule it broke, taken from the schema the wire uses.
    const schema = message.startsWith("--label key")
      ? labelKeySchema
      : labelValueSchema;
    expect(schema.description).toBeTruthy();
    expect(result.stderr).toContain(`(${schema.description})`);
  });

  it("refuses more than 32 labels", () => {
    const args = Array.from({ length: 33 }, (_, i) => [
      "--label",
      `k${i}=v`,
    ]).flat();
    const result = runParseArgs([...DAEMON, ...args]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("at most 32 labels");
  });

  it("refuses --label without --cp-id instead of ignoring it", () => {
    // Without a cpId nothing is bootstrapped, so the labels would have no
    // charge point to land on — the silent no-op #295 rejected for --cp-count.
    const result = runParseArgs(["--daemon", "--label", "site=a"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--label requires --cp-id");
  });

  it("refuses --label outside a server mode instead of ignoring it", () => {
    const result = runParseArgs([
      "--cp-id",
      "CP",
      "--ws-url",
      "ws://csms.example.test/ocpp/",
      "--label",
      "site=a",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--label needs a server mode");
  });

  it("refuses --label alongside a client mode even when a server flag is present", () => {
    // `--http-port` makes the server-mode guard pass, but `--send` returns
    // through the client path before any charge point is bootstrapped — the
    // hole #314 closed for --watch.
    const result = runParseArgs([
      "--send",
      "status",
      "--cp-id",
      "CP",
      "--http-port",
      "9000",
      "--label",
      "site=a",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "--label cannot be combined with a client mode",
    );
  });

  it.each([[["--stop"]], [["--events", "--all"]]])(
    "gives the client-mode reason for %j without --cp-id",
    (mode) => {
      // Those modes need no --cp-id, so "requires --cp-id" would send the
      // operator after the wrong fix.
      const result = runParseArgs([...mode, "--label", "site=a"]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "--label cannot be combined with a client mode",
      );
    },
  );
});

describe("parseArgs --fleet-template (#445)", () => {
  const DAEMON = ["--daemon"];

  it("collects every repeated --fleet-template", () => {
    const result = runParseArgs([
      ...DAEMON,
      "--fleet-template",
      "a.json",
      "--fleet-template",
      "b.json",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).fleetTemplateFiles).toEqual([
      "a.json",
      "b.json",
    ]);
  });

  it("is empty by default", () => {
    expect(JSON.parse(runParseArgs(DAEMON).stdout).fleetTemplateFiles).toEqual(
      [],
    );
  });

  it("is refused without a path", () => {
    const noPath = runParseArgs([...DAEMON, "--fleet-template"]);
    expect(noPath.status).toBe(1);
    expect(noPath.stderr).toContain("--fleet-template needs a file path");
  });

  it("is refused outside a server mode", () => {
    const standalone = runParseArgs([
      "--cp-id",
      "CP",
      "--ws-url",
      "ws://csms.example.test/ocpp/",
      "--fleet-template",
      "a.json",
    ]);
    expect(standalone.status).toBe(1);
    expect(standalone.stderr).toContain("--fleet-template needs a server mode");
  });
});

describe("daemon operations flags (#620, #621, #622)", () => {
  it("defaults keep today's behavior", () => {
    const result = runParseArgs(["--daemon"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).ops).toEqual({
      allowedHosts: [],
      trustedProxies: [],
      requireTls: false,
      rateLimitPerIp: 0,
      rateLimitMaxIps: 10000,
      logLevel: null,
      logFile: null,
      logMaxBytes: null,
      logRotateDaily: false,
      logKeep: 5,
      shutdownStopTransactions: false,
      shutdownWaitMs: 5000,
      connectRestored: true,
      cpBulkWaitMs: 10000,
    });
  });

  it("parses every flag", () => {
    const result = runParseArgs([
      "--daemon",
      "--allowed-host",
      "a.example",
      "--allowed-host",
      "b.example:9700",
      "--trusted-proxy",
      "10.0.0.0/8",
      "--require-tls",
      "--rate-limit-per-ip",
      "20",
      "--rate-limit-max-ips",
      "500",
      "--log-level",
      "warn",
      "--log-file",
      "/tmp/x.log",
      "--log-max-size",
      "10m",
      "--log-rotate-daily",
      "--log-keep",
      "7",
      "--shutdown-stop-transactions",
      "--shutdown-wait-ms",
      "9000",
      "--no-connect-restored",
      "--cp-bulk-wait-ms",
      "20000",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).ops).toEqual({
      allowedHosts: ["a.example", "b.example:9700"],
      trustedProxies: ["10.0.0.0/8"],
      requireTls: true,
      rateLimitPerIp: 20,
      rateLimitMaxIps: 500,
      logLevel: "warn",
      logFile: "/tmp/x.log",
      logMaxBytes: 10 * 1024 * 1024,
      logRotateDaily: true,
      logKeep: 7,
      shutdownStopTransactions: true,
      shutdownWaitMs: 9000,
      connectRestored: false,
      cpBulkWaitMs: 20000,
    });
  });

  it.each([
    [["--trusted-proxy", "not-an-ip"], "--trusted-proxy"],
    [["--log-level", "loud"], "--log-level"],
    [["--log-max-size", "big"], "--log-max-size"],
    [["--rate-limit-max-ips", "0"], "--rate-limit-max-ips"],
  ])("rejects %j", (args, flag) => {
    const result = runParseArgs(["--daemon", ...args]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(flag);
  });
});

describe("parseArgs startup pacing (#610)", () => {
  const DAEMON = [
    "--daemon",
    "--cp-id",
    "CP",
    "--cp-count",
    "20",
    "--ws-url",
    "ws://csms.example.test/ocpp/",
  ];

  it("has no pacing unless asked for, so the built-in default applies", () => {
    const result = runParseArgs(DAEMON);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).bootstrapPacing).toBeNull();
  });

  it("collects the four flags and fills the rest from the defaults", () => {
    const result = runParseArgs([
      ...DAEMON,
      "--bootstrap-concurrency",
      "2",
      "--start-delay",
      "250",
      "--start-jitter",
      "100",
      "--start-seed",
      "7",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).bootstrapPacing).toEqual({
      concurrency: 2,
      startDelayMs: 250,
      startJitterMs: 100,
      startSeed: 7,
    });
  });

  it("fills the pacing defaults around a single flag", () => {
    const partial = runParseArgs([...DAEMON, "--start-delay", "50"]);
    expect(JSON.parse(partial.stdout).bootstrapPacing).toEqual({
      concurrency: 8,
      startDelayMs: 50,
      startJitterMs: 0,
      startSeed: 0,
    });
  });

  it.each([
    [["--bootstrap-concurrency", "0"], "--bootstrap-concurrency must be"],
    [["--bootstrap-concurrency", "x"], "--bootstrap-concurrency must be"],
    [["--start-delay", "-1"], "--start-delay must be"],
    [["--start-jitter", "1.5"], "--start-jitter must be"],
    [
      ["--start-seed", "3"],
      "--start-seed has no effect without --start-jitter",
    ],
  ])("refuses %j", (flags, message) => {
    const result = runParseArgs([...DAEMON, ...flags]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("refuses the flags outside a server mode", () => {
    const standalone = runParseArgs([
      "--cp-id",
      "CP",
      "--ws-url",
      "ws://csms.example.test/ocpp/",
      "--start-delay",
      "10",
    ]);
    expect(standalone.status).toBe(1);
    expect(standalone.stderr).toContain("--start-delay needs a server mode");
  });

  it("refuses the flags without --cp-id", () => {
    const noCp = runParseArgs(["--daemon", "--start-delay", "10"]);
    expect(noCp.status).toBe(1);
    expect(noCp.stderr).toContain("--start-delay needs a server mode");
  });

  it("refuses the flags combined with a client mode, even next to --http-port", () => {
    const result = runParseArgs([
      "--http-port",
      "9700",
      "--send",
      '{"method":"cp.list"}',
      "--cp-id",
      "CP",
      "--start-delay",
      "10",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--start-delay cannot be combined with a client mode",
    );
  });

  it("refuses a schedule longer than a timer can hold", () => {
    const tooLong = runParseArgs([...DAEMON, "--start-delay", "200000000"]);
    expect(tooLong.status).toBe(1);
    expect(tooLong.stderr).toContain("must not exceed 2147483647 ms");
  });

  it("accepts the largest schedule a timer can hold", () => {
    // (20 - 1) × 113025455 = 2147483645, plus a jitter of 2.
    const edge = runParseArgs([
      ...DAEMON,
      "--start-delay",
      "113025455",
      "--start-jitter",
      "2",
    ]);
    expect(edge.status).toBe(0);
  });

  it("refuses a schedule one millisecond over the largest one", () => {
    const over = runParseArgs([
      ...DAEMON,
      "--start-delay",
      "113025455",
      "--start-jitter",
      "3",
    ]);
    expect(over.status).toBe(1);
  });
});
