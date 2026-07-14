import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function runParseArgs(args: string[]) {
  const script = [
    'import { parseArgs } from "./src/cli/main.ts";',
    'import { buildOcppWebSocketConnectOptions } from "./src/cp/infrastructure/transport/wsUrlWithBasic.ts";',
    `const options = parseArgs(["bun", "src/cli/main.ts", ...${JSON.stringify(
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
    "  hasWebConsoleBasicAuth: options.webConsoleBasicAuth !== null,",
    "}));",
  ].join("\n");

  return spawnSync("bun", ["--eval", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

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
