import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function runParseArgs(args: string[]) {
  const script = [
    'import { parseArgs } from "./src/cli/main.ts";',
    `const options = parseArgs(["bun", "src/cli/main.ts", ...${JSON.stringify(
      args,
    )}]);`,
    "console.log(JSON.stringify({",
    "  ocppVersion: options.ocppVersion ?? null,",
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

describe("parseArgs --ocpp-version", () => {
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
      "Error: --ocpp-version must be one of OCPP-1.5, OCPP-1.6J, OCPP-2.0.1, OCPP-2.1",
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
