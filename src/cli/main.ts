#!/usr/bin/env bun
import * as path from "path";
import * as fs from "fs";
import type { CLIOptions, ChargePointInitOptions } from "./types";
import { CLIChargePointService } from "./service";
import { startRepl } from "./repl";
import { startJsonMode } from "./jsonMode";
import { resolveClientLocation } from "./clientLocation";
import { isHttpUrl, resolveSoapCallbackUrl } from "./soapCallbackUrl";
import { BunSqliteDatabase } from "../cp/domain/persistence/BunSqliteDatabase";
import type { Database } from "../cp/domain/persistence/Database";
import { SqliteScenarioRepository } from "../cp/domain/persistence/SqliteScenarioRepository";
import { setGlobalLogFormat } from "../cp/shared/Logger";
import {
  startServer,
  DEFAULT_HTTP_PORT,
  DEFAULT_PID_PATH,
} from "./server/startServer";
import { CPRegistry } from "./server/CPRegistry";
import { EventBus } from "./server/eventBus";
import { RegistryChargePointService } from "./server/RegistryChargePointService";
import { createSocketConfigRepository } from "./server/socketServer";
import { sendCommand, subscribeEvents, stopDaemon } from "./client";
import type { ClientLocation } from "./client";
import type { SingleCpRuntimeTarget } from "./singleCpTarget";
import { SqliteConnectorSettingsRepository } from "../data/sqlite/SqliteConnectorSettingsRepository";
import {
  isOcppVersion,
  SUPPORTED_OCPP_VERSIONS,
} from "../cp/domain/types/OcppVersion";
import { tlsKeyPermissionWarning } from "./tlsKeyPermissions";

/**
 * Locate the bundled web console (Vite-built `dist/`) shipped alongside
 * the CLI. The published package layout is `<pkg>/src/cli/main.ts` +
 * `<pkg>/dist/`, so we walk up from this file's directory. Returns null
 * when the build isn't present — typical when running from a fresh
 * checkout where `bun run build` hasn't been invoked yet.
 */
function resolveBundledDist(): string | null {
  const candidate = path.resolve(import.meta.dir, "../../dist");
  try {
    if (fs.statSync(path.join(candidate, "index.html")).isFile()) {
      return candidate;
    }
  } catch {
    // not built / not present
  }
  return null;
}

const OCPP_VERSION_VALUES = SUPPORTED_OCPP_VERSIONS.join(", ");

function parseSecurityProfile(
  value: string | undefined,
): CLIOptions["securityProfile"] {
  if (value === "0" || value === "1" || value === "2" || value === "3") {
    return Number(value) as CLIOptions["securityProfile"];
  }
  process.stderr.write("Error: --security-profile must be one of 0, 1, 2, 3\n");
  process.exit(1);
}

function requireFlagValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    process.stderr.write(`Error: ${flag} requires a value\n`);
    process.exit(1);
  }
  return value;
}

function readPemFile(flag: string, filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    process.stderr.write(
      `Error: failed to read ${flag} file '${filePath}': ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    process.exit(1);
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}

export function parseArgs(argv: string[]): CLIOptions {
  let wsUrl = "";
  let cpId: string | null = null;
  let connectors = 1;
  let jsonMode = false;
  let daemon = false;
  let send: string | null = null;
  let events = false;
  let stop = false;
  let basicAuthUser = "";
  let basicAuthPass = "";
  // HTTP web-console Basic Auth credentials. Distinct from basicAuthUser /
  // basicAuthPass above — those are sent on the *outgoing* CP → CSMS WS
  // upgrade; these gate *incoming* HTTP requests to this daemon.
  let webConsoleBasicAuthUser = "";
  let webConsoleBasicAuthPass = "";
  // Basic Auth the CLI *client* modes (--send/--stop/--events) send TO a
  // daemon protected by --web-console-basic-auth-*. Outbound, mirror image of
  // webConsoleBasicAuth* above (which is the daemon's inbound gate).
  let httpBasicAuthUser = "";
  let httpBasicAuthPass = "";
  let vendor = "CLI-Vendor";
  let model = "CLI-Model";
  let ocppVersion: string | undefined;
  let scenario: string | null = null;
  let scenarioTemplate: string | null = null;
  let scenarioTemplateFile: string | null = null;
  let scenarioConnector = "1";
  let httpPort: number | null = null;
  let httpHost = "127.0.0.1";
  let unixSocket: string | null = null;
  let unixSocketWarningPrinted = false;
  let httpUrl: string | null = null;
  let allEvents = false;
  let unsafeRemote = false;
  let serveStatic: string | null = null;
  // --web-console: enabled flag + optional explicit port. When the port is
  // omitted (`--web-console` alone), the UI shares the --http-port listener.
  let webConsoleEnabled = false;
  let webConsoleExplicitPort: number | null = null;
  let stateDb: string | null = null;
  let logFormat: "plain" | "json" = "plain";
  let healthPath = "/v1/healthz";
  const corsOrigins: string[] = [];
  let trustForwardedHeaders = false;
  const extraWsHeaders: Record<string, string> = {};
  const extraWsSubprotocols: string[] = [];
  let soapCallbackUrl: string | null = null;
  let soapPublicBaseUrl: string | null = null;
  let soapPath = "/ocpp/soap";
  let securityProfile: CLIOptions["securityProfile"];
  let authorizationKey: string | undefined;
  let tlsCaPath: string | undefined;
  let tlsCertPath: string | undefined;
  let tlsKeyPath: string | undefined;
  let insecureTlsKeyPerms = false;
  let cpoName: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case "--ws-url":
        wsUrl = next ?? "";
        i++;
        break;
      case "--cp-id":
        cpId = next ?? "";
        i++;
        break;
      case "--connectors":
        connectors = parseInt(next ?? "1", 10);
        i++;
        break;
      case "--json":
        jsonMode = true;
        break;
      case "--daemon":
        daemon = true;
        break;
      case "--send":
        send = next ?? "";
        i++;
        break;
      case "--events":
        events = true;
        break;
      case "--stop":
        stop = true;
        break;
      case "--basic-auth-user":
        basicAuthUser = next ?? "";
        i++;
        break;
      case "--basic-auth-pass":
        basicAuthPass = next ?? "";
        i++;
        break;
      case "--web-console-basic-auth-user":
        webConsoleBasicAuthUser = next ?? "";
        i++;
        break;
      case "--web-console-basic-auth-pass":
        webConsoleBasicAuthPass = next ?? "";
        i++;
        break;
      case "--http-basic-auth-user":
        httpBasicAuthUser = next ?? "";
        i++;
        break;
      case "--http-basic-auth-pass":
        httpBasicAuthPass = next ?? "";
        i++;
        break;
      case "--vendor":
        vendor = next ?? "";
        i++;
        break;
      case "--model":
        model = next ?? "";
        i++;
        break;
      case "--ocpp-version":
        if (!next || next.startsWith("--") || !isOcppVersion(next)) {
          process.stderr.write(
            `Error: --ocpp-version must be one of ${OCPP_VERSION_VALUES}\n`,
          );
          process.exit(1);
        }
        ocppVersion = next;
        i++;
        break;
      case "--scenario":
        scenario = next ?? "";
        i++;
        break;
      case "--scenario-template":
        scenarioTemplate = next ?? "";
        i++;
        break;
      case "--scenario-template-file":
        scenarioTemplateFile = next ?? "";
        i++;
        break;
      case "--scenario-connector":
        scenarioConnector = next ?? "1";
        i++;
        break;
      case "--http-port":
        httpPort = parseInt(next ?? "", 10);
        i++;
        break;
      case "--http-host":
        httpHost = next ?? "";
        i++;
        break;
      case "--unix-socket":
        if (!unixSocketWarningPrinted) {
          process.stderr.write(
            "Warning: --unix-socket is deprecated and ignored; the daemon " +
              `uses TCP loopback by default (http://127.0.0.1:${DEFAULT_HTTP_PORT}).\n`,
          );
          unixSocketWarningPrinted = true;
        }
        unixSocket = null;
        if (next && !next.startsWith("--")) i++;
        break;
      case "--http-url":
        httpUrl = next ?? "";
        i++;
        break;
      case "--all":
        allEvents = true;
        break;
      case "--unsafe-remote":
        unsafeRemote = true;
        break;
      case "--cors-origin":
        if (!next || next.startsWith("--")) {
          process.stderr.write(
            "Error: --cors-origin requires a value (refusing to fall back to open CORS)\n",
          );
          process.exit(1);
        }
        corsOrigins.push(next);
        i++;
        break;
      case "--trust-forwarded-headers":
        trustForwardedHeaders = true;
        break;
      case "--state-db":
        if (!next || next.startsWith("--")) {
          process.stderr.write(
            "Error: --state-db requires a path (or ':memory:')\n",
          );
          process.exit(1);
        }
        stateDb = next;
        i++;
        break;
      case "--log-format":
        if (next !== "plain" && next !== "json") {
          process.stderr.write(
            "Error: --log-format must be 'plain' or 'json'\n",
          );
          process.exit(1);
        }
        logFormat = next;
        i++;
        break;
      case "--health-path":
        if (!next || next.startsWith("--") || !next.startsWith("/")) {
          process.stderr.write(
            "Error: --health-path requires an absolute path starting with '/'\n",
          );
          process.exit(1);
        }
        healthPath = next;
        i++;
        break;
      case "--header": {
        if (!next || next.startsWith("--")) {
          process.stderr.write(
            "Error: --header requires KEY:VALUE (use multiple --header flags for several headers)\n",
          );
          process.exit(1);
        }
        const idx = next.indexOf(":");
        if (idx <= 0) {
          process.stderr.write(
            `Error: --header value must be KEY:VALUE, got '${next}'\n`,
          );
          process.exit(1);
        }
        const k = next.slice(0, idx).trim();
        const v = next.slice(idx + 1).trim();
        if (!k) {
          process.stderr.write("Error: --header KEY part is empty\n");
          process.exit(1);
        }
        extraWsHeaders[k] = v;
        i++;
        break;
      }
      case "--ws-subprotocol":
        if (!next || next.startsWith("--")) {
          process.stderr.write("Error: --ws-subprotocol requires a value\n");
          process.exit(1);
        }
        extraWsSubprotocols.push(next);
        i++;
        break;
      case "--soap-callback-url":
        if (!next || next.startsWith("--")) {
          process.stderr.write("Error: --soap-callback-url requires a URL\n");
          process.exit(1);
        }
        soapCallbackUrl = next;
        i++;
        break;
      case "--soap-public-base-url":
        if (!next || next.startsWith("--")) {
          process.stderr.write(
            "Error: --soap-public-base-url requires a URL\n",
          );
          process.exit(1);
        }
        if (!isHttpUrl(next)) {
          process.stderr.write(
            "Error: --soap-public-base-url must be an absolute http(s) URL\n",
          );
          process.exit(1);
        }
        soapPublicBaseUrl = next;
        i++;
        break;
      case "--soap-path":
        if (!next || next.startsWith("--") || !next.startsWith("/")) {
          process.stderr.write(
            "Error: --soap-path requires an absolute path starting with '/'\n",
          );
          process.exit(1);
        }
        soapPath = next.replace(/\/+$/, "") || "/";
        i++;
        break;
      case "--security-profile":
        securityProfile = parseSecurityProfile(next);
        i++;
        break;
      case "--authorization-key":
        authorizationKey = requireFlagValue("--authorization-key", next);
        if (!/^[0-9a-fA-F]+$/.test(authorizationKey)) {
          process.stderr.write(
            "Error: --authorization-key must be a non-empty hex string\n",
          );
          process.exit(1);
        }
        i++;
        break;
      case "--tls-ca":
        tlsCaPath = requireFlagValue("--tls-ca", next);
        i++;
        break;
      case "--tls-cert":
        tlsCertPath = requireFlagValue("--tls-cert", next);
        i++;
        break;
      case "--tls-key":
        tlsKeyPath = requireFlagValue("--tls-key", next);
        i++;
        break;
      case "--insecure-tls-key-perms":
        insecureTlsKeyPerms = true;
        break;
      case "--cpo-name":
        cpoName = requireFlagValue("--cpo-name", next);
        i++;
        break;
      case "--web-console":
        webConsoleEnabled = true;
        // Optional port: only consume `next` when it looks like a number.
        // If `next` is missing or another flag, the UI shares --http-port.
        if (next && !next.startsWith("--") && /^\d+$/.test(next)) {
          webConsoleExplicitPort = parseInt(next, 10);
          i++;
        }
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          process.stderr.write(`Unknown option: ${arg}\n`);
          printUsage();
          process.exit(1);
        }
    }
  }

  const isClientMode = send !== null || events || stop;

  if (!isClientMode && daemon && httpPort == null) {
    httpPort = DEFAULT_HTTP_PORT;
  }

  let webConsolePort: number | null = null;
  if (webConsoleEnabled) {
    if (
      webConsoleExplicitPort != null &&
      (isNaN(webConsoleExplicitPort) || webConsoleExplicitPort < 1)
    ) {
      process.stderr.write(
        "Error: --web-console port must be a positive integer\n",
      );
      process.exit(1);
    }
    // Port resolution: explicit > --http-port > error.
    webConsolePort = webConsoleExplicitPort ?? httpPort;
    if (webConsolePort == null) {
      process.stderr.write(
        "Error: --web-console without a port requires --http-port " +
          "(the UI shares that listener). Pass a port to --web-console, " +
          "or add --http-port <port>.\n",
      );
      process.exit(1);
    }
    const bundled = resolveBundledDist();
    if (!bundled) {
      process.stderr.write(
        "Error: --web-console requires the bundled UI to be built. " +
          "Run `bun run build` in the repo first " +
          "(or use an installed package which ships dist/).\n",
      );
      process.exit(1);
    }
    serveStatic = bundled;
    // --web-console alone is enough to put the daemon into server mode —
    // even without --http-port, the web-console port carries socket.io/health
    // alongside the UI on the same origin.
  }

  const isServerMode = daemon || httpPort != null || webConsoleEnabled;

  if (isClientMode) {
    if ((send !== null || events) && !cpId && !allEvents) {
      process.stderr.write(
        "Error: --cp-id is required (or --all for --events)\n",
      );
      printUsage();
      process.exit(1);
    }
  } else if (!isServerMode) {
    // REPL / JSON mode requires a single bootstrapped CP
    if (!cpId) {
      process.stderr.write("Error: --cp-id is required\n");
      printUsage();
      process.exit(1);
    }
    if (!wsUrl) {
      process.stderr.write("Error: --ws-url is required\n");
      printUsage();
      process.exit(1);
    }
  } else {
    // Server mode: cpId is bootstrap-only. If given, ws-url is also required.
    if (cpId && !wsUrl) {
      process.stderr.write(
        "Error: --ws-url is required when bootstrapping a CP with --cp-id\n",
      );
      printUsage();
      process.exit(1);
    }
  }

  if (isNaN(connectors) || connectors < 1) {
    process.stderr.write("Error: --connectors must be a positive integer\n");
    process.exit(1);
  }

  if (httpPort != null && (isNaN(httpPort) || httpPort < 1)) {
    process.stderr.write("Error: --http-port must be a positive integer\n");
    process.exit(1);
  }

  // Unix sockets are deprecated for the daemon control plane. The flag is
  // still accepted above for launcher compatibility, but it is always ignored.
  if (isServerMode) {
    unixSocket = null;
  }

  const basicAuth =
    basicAuthUser && basicAuthPass
      ? { username: basicAuthUser, password: basicAuthPass }
      : null;

  // Both web-console flags must be supplied together. Half-configured auth
  // (e.g. user without pass) would let everyone in or block everyone out,
  // so we hard-fail at startup instead of silently picking one.
  if ((webConsoleBasicAuthUser === "") !== (webConsoleBasicAuthPass === "")) {
    process.stderr.write(
      "Error: --web-console-basic-auth-user and --web-console-basic-auth-pass " +
        "must be supplied together (or both omitted)\n",
    );
    process.exit(1);
  }
  const webConsoleBasicAuth =
    webConsoleBasicAuthUser && webConsoleBasicAuthPass
      ? {
          username: webConsoleBasicAuthUser,
          password: webConsoleBasicAuthPass,
        }
      : null;

  if (
    !isClientMode &&
    isServerMode &&
    !isLoopbackHost(httpHost) &&
    !webConsoleBasicAuth &&
    !unsafeRemote
  ) {
    process.stderr.write(
      `Error: refusing to bind unauthenticated daemon to non-loopback host ` +
        `${httpHost}. Configure --web-console-basic-auth-user and ` +
        "--web-console-basic-auth-pass, bind to 127.0.0.1/localhost/::1, " +
        "or pass --unsafe-remote to override.\n",
    );
    process.exit(1);
  }

  // Same all-or-nothing rule for the client-side credentials.
  if ((httpBasicAuthUser === "") !== (httpBasicAuthPass === "")) {
    process.stderr.write(
      "Error: --http-basic-auth-user and --http-basic-auth-pass " +
        "must be supplied together (or both omitted)\n",
    );
    process.exit(1);
  }
  const httpBasicAuth =
    httpBasicAuthUser && httpBasicAuthPass
      ? { username: httpBasicAuthUser, password: httpBasicAuthPass }
      : null;
  let tls: CLIOptions["tls"];
  if (tlsCaPath || tlsCertPath || tlsKeyPath) {
    tls = {};
    if (tlsCaPath) tls = { ...tls, ca: readPemFile("--tls-ca", tlsCaPath) };
    if (tlsCertPath) {
      tls = { ...tls, cert: readPemFile("--tls-cert", tlsCertPath) };
    }
    if (tlsKeyPath) {
      const warning = tlsKeyPermissionWarning(tlsKeyPath);
      if (warning && !insecureTlsKeyPerms) {
        process.stderr.write(
          `Error: ${warning}. Pass --insecure-tls-key-perms to override.\n`,
        );
        process.exit(1);
      }
      if (warning) {
        process.stderr.write(
          `Warning: ${warning}; proceeding because --insecure-tls-key-perms was passed.\n`,
        );
      }
      tls = { ...tls, key: readPemFile("--tls-key", tlsKeyPath) };
    }
  }

  // Resolve the SOAP callback URL by precedence: an explicit --soap-callback-url
  // wins; otherwise --soap-public-base-url derives it. (A tunnel provider such
  // as ngrok would slot in below the public base — see soapCallbackUrl.ts.)
  const resolvedSoapCallbackUrl = resolveSoapCallbackUrl({
    explicitCallbackUrl: soapCallbackUrl,
    publicBaseUrl: soapPublicBaseUrl,
    cpId,
    soapPath,
  });
  if (!soapCallbackUrl && soapPublicBaseUrl && resolvedSoapCallbackUrl) {
    process.stderr.write(
      `SOAP callback URL resolved from --soap-public-base-url: ${resolvedSoapCallbackUrl}\n`,
    );
  }

  return {
    wsUrl,
    cpId,
    connectors,
    jsonMode,
    daemon,
    send,
    events,
    stop,
    basicAuth,
    webConsoleBasicAuth,
    vendor,
    model,
    ocppVersion,
    scenario,
    scenarioTemplate,
    scenarioTemplateFile,
    scenarioConnector,
    httpPort,
    httpHost,
    unixSocket,
    httpUrl,
    httpBasicAuth,
    allEvents,
    unsafeRemote,
    corsOrigins,
    trustForwardedHeaders,
    serveStatic,
    webConsolePort,
    stateDb,
    logFormat,
    healthPath,
    extraWsHeaders,
    extraWsSubprotocols,
    soapCallbackUrl: resolvedSoapCallbackUrl,
    soapPath,
    securityProfile,
    authorizationKey,
    cpoName,
    tls,
    tlsCaPath,
    tlsCertPath,
    tlsKeyPath,
    insecureTlsKeyPerms,
  };
}

function printUsage(): void {
  process.stderr.write(`
Usage: ocpp-cp-sim [options]    (or "bun src/cli/main.ts [options]" from a checkout)

Local modes (single CP, no server):
  --cp-id <id> --ws-url <url>                Interactive REPL (default)
  --cp-id <id> --ws-url <url> --json         JSON Lines mode

Server modes (HTTP/WebSocket, multi-CP):
  --daemon [--cp-id X --ws-url Y]                  Background TCP server (127.0.0.1:${DEFAULT_HTTP_PORT})
  --daemon --http-port P [--cp-id ...]             Background TCP server on port P
  --http-port P [--cp-id ...]                      Foreground TCP server

Client modes (talk to a running server):
  --send <json> --cp-id <id> [target]        Send command to a CP
  --events --cp-id <id> [target]             Subscribe per-CP events
  --events --all [target]                    Subscribe all-CP events
  --stop [target]                            Shut down the server

  [target] = --http-url http://host:port  (default http://127.0.0.1:${DEFAULT_HTTP_PORT})

Options:
  --cp-id <id>             Charge Point ID
  --ws-url <url>           WebSocket URL of CSMS
  --connectors <n>         Number of connectors (default: 1)
  --security-profile <0|1|2|3>
                           OCPP 1.6 security profile. 0 leaves transport/auth
                           as configured; 1 forces ws:// + AuthorizationKey
                           Basic Auth; 2 forces wss:// + AuthorizationKey
                           Basic Auth + verified server cert; 3 forces
                           wss:// mTLS and suppresses Basic Auth.
  --authorization-key <hex> AuthorizationKey used as Basic Auth password for
                           security profiles 1 and 2 (username is CP ID).
  --tls-ca <path>          PEM CA bundle used to verify the CSMS server cert.
  --tls-cert <path>        PEM client certificate for profile 3 mTLS.
  --tls-key <path>         PEM client private key for profile 3 mTLS.
                           Must be mode 0600 unless
                           --insecure-tls-key-perms is passed.
  --insecure-tls-key-perms Allow --tls-key files readable by group/other.
  --cpo-name <name>        CPO name for generated SignCertificate CSRs.
  --basic-auth-user <u>    Outgoing WS Basic auth username (CP → CSMS)
  --basic-auth-pass <p>    Outgoing WS Basic auth password (CP → CSMS)
  --web-console-basic-auth-user <u>
                           Basic auth user for INCOMING HTTP requests to
                           this daemon (web console / socket.io).
                           Must be supplied together with
                           --web-console-basic-auth-pass. Default: no auth.
  --web-console-basic-auth-pass <p>
                           Basic auth password for INCOMING HTTP. The
                           configured health path (--health-path, default
                           /v1/healthz) is always served without auth so
                           k8s probes / load balancers keep working.
  --http-basic-auth-user <u>
                           Basic auth user the CLIENT modes (--send / --stop /
                           --events) send to a daemon protected by
                           --web-console-basic-auth-*. Pair with
                           --http-basic-auth-pass.
  --http-basic-auth-pass <p>
                           Basic auth password for the client modes (see above).
  --vendor <vendor>        Charge point vendor (default: CLI-Vendor)
  --model <model>          Charge point model (default: CLI-Model)
  --ocpp-version <OCPP-1.2|OCPP-1.5|OCPP-1.6J|OCPP-1.6S|OCPP-2.0.1|OCPP-2.1>
                           OCPP version for a directly-started CP
                           (default: OCPP-1.6J)
  --scenario <file>            Run scenario from JSON file on startup
  --scenario-template <id>     Run built-in scenario template on startup
  --scenario-template-file <p> Load a cpId-independent template JSON and apply it
                               to every connector listed in --scenario-connector
  --scenario-connector <list>  Target connectors: "all", a single id ("1"),
                               or a comma-separated list ("1,2,3"). Default: 1
  --http-port <port>       Enable HTTP/WebSocket server on this TCP port
  --http-host <addr>       Bind address for HTTP (default: 127.0.0.1)
  --unix-socket <path|none> Deprecated no-op; accepted for launcher compatibility
  --http-url <url>         Client target: TCP HTTP base URL
  --all                    Use the global event stream (--events only)
  --unsafe-remote          Allow a non-loopback daemon bind without
                           --web-console-basic-auth-user/pass. Use only on
                           trusted networks.
  --cors-origin <origin>   Restrict CORS to this origin (repeatable). Pass "*"
                           for open CORS. Default: open on a loopback bind;
                           same-origin-only when bound to a non-loopback host
                           (0.0.0.0 / LAN) so cross-site browser calls are
                           rejected.
  --trust-forwarded-headers
                           With the same-origin default, also accept the
                           public origin a reverse proxy reports via
                           X-Forwarded-Proto / X-Forwarded-Host. Use only
                           behind a trusted proxy (see docs/server.md).
  --web-console [<port>]   Serve the bundled browser UI alongside socket.io.
                           With <port>: opens a second listener on that port.
                           Without <port>: shares the --http-port listener.
                           Requires the UI to be built (run "bun run build",
                           or use an installed package which ships dist/).
  --state-db <path>        Persist Configuration overrides, charging-profile
                           state, scenarios, and pending transaction
                           messages to a SQLite file (or ":memory:").
                           Without this flag the daemon is fully in-memory
                           and forgets everything at exit.
  --log-format <fmt>       "plain" (default) or "json" — output one JSON
                           object per stderr line for structured-log
                           collectors (Loki, jq, etc.).
  --health-path <path>     Absolute path the health-check JSON is served on
                           (default: /v1/healthz). Change this when running
                           behind a proxy that reserves the default path
                           (e.g. Cloud Run / GFE). The browser UI build must
                           be given the matching VITE_HEALTH_PATH so its
                           remote-mode auto-detect probe lines up.
  --soap-callback-url <url>
                           SOAP ChargePointService callback URL for OCPP 1.2, 1.5,
                           or 1.6S. Required for SOAP versions unless
                           --soap-public-base-url is given instead.
  --soap-public-base-url <url>
                           Public base URL (e.g. a tunnel origin) the CSMS can
                           reach; the full callback URL is derived as
                           {base}{soap-path}/{cp-id}/ChargePointService. An
                           explicit --soap-callback-url takes precedence.
  --soap-path <path>       Base path reserved for the SOAP callback server
                           (default: /ocpp/soap).
                           OCPP-S has no per-message auth; rely on
                           --web-console-basic-auth-* or a trusted network.
  -h, --help               Show this help

HTTP endpoints (see docs/server.md):
  GET    /v1/healthz       (or whatever --health-path is set to)
  GET    /socket.io/       Socket.IO / Engine.IO transport
  POST   /socket.io/       Socket.IO / Engine.IO transport
`);
}

/**
 * Pick the CORS policy at startup.
 *
 * Rules:
 *   - Explicit `--cors-origin <origin>` (one or more)   → `allowlist`.
 *   - Explicit `--cors-origin "*"` (literal star)       → `any` (operator
 *     deliberately opted into open CORS).
 *   - No `--cors-origin` flag + binding to a loopback host (127.0.0.1
 *     / ::1 / localhost) → `any`. Loopback can't be reached from anyone
 *     else's browser, so open CORS is fine.
 *   - No `--cors-origin` flag + binding to a non-loopback host
 *     (0.0.0.0, LAN IP, hostname) → `same-origin` AND a warning to
 *     stderr. The daemon is exposed on the LAN; defaulting to open
 *     CORS would let any page in the operator's browser call it.
 */
function resolveCorsPolicy(
  options: CLIOptions,
):
  | { kind: "any" }
  | { kind: "allowlist"; origins: string[] }
  | { kind: "same-origin"; trustForwardedHeaders: boolean } {
  if (options.corsOrigins.length > 0) {
    if (options.corsOrigins.length === 1 && options.corsOrigins[0] === "*") {
      return { kind: "any" };
    }
    return { kind: "allowlist", origins: [...options.corsOrigins] };
  }
  const host = options.httpHost;
  if (isLoopbackHost(host)) return { kind: "any" };
  if (!options.trustForwardedHeaders) {
    process.stderr.write(
      `[server] WARNING: binding to ${host} without --cors-origin; ` +
        "applying same-origin-only CORS so cross-site browser requests are " +
        'rejected. Pass `--cors-origin "*"` to opt back into open CORS, ' +
        "`--cors-origin https://your.ui` for an explicit allowlist, or " +
        "`--trust-forwarded-headers` when running behind a reverse proxy " +
        "that sets X-Forwarded-Proto/Host.\n",
    );
  }
  return {
    kind: "same-origin",
    trustForwardedHeaders: options.trustForwardedHeaders,
  };
}

function buildBootstrap(options: CLIOptions): ChargePointInitOptions | null {
  if (!options.cpId) return null;
  return {
    cpId: options.cpId,
    wsUrl: options.wsUrl,
    centralSystemUrl: options.wsUrl,
    connectors: options.connectors,
    vendor: options.vendor,
    model: options.model,
    ocppVersion: options.ocppVersion,
    soapCallbackUrl: options.soapCallbackUrl ?? undefined,
    soapPath: options.soapPath,
    basicAuth: options.basicAuth,
    extraWsHeaders: options.extraWsHeaders,
    extraWsSubprotocols: options.extraWsSubprotocols,
    securityProfile: options.securityProfile,
    authorizationKey: options.authorizationKey,
    cpoName: options.cpoName,
    tls: options.tls,
    tlsCaPath: options.tlsCaPath,
    tlsCertPath: options.tlsCertPath,
    tlsKeyPath: options.tlsKeyPath,
  };
}

function createStandaloneChargePointRuntime(
  options: CLIOptions,
  database: Database | null,
): SingleCpRuntimeTarget {
  const bootstrap = buildBootstrap(options);
  if (!bootstrap) {
    throw new Error("cpId is required");
  }

  const bus = new EventBus();
  const registry = new CPRegistry(bus, database, {
    allowInsecureTlsKeyPerms: options.insecureTlsKeyPerms,
  });
  const configRepository = createSocketConfigRepository(database);
  const scenarioRepository = new SqliteScenarioRepository(database);
  const connectorSettingsRepository = new SqliteConnectorSettingsRepository(
    database,
  );
  const chargePointService = new RegistryChargePointService(registry, {
    database,
    configRepository,
    scenarioRepository,
    connectorSettingsRepository,
  });
  const eventSource = registry.registerExisting(
    CLIChargePointService.fromOptions(options, database),
  );

  return {
    chargePointService,
    cpId: bootstrap.cpId,
    eventSource,
    cleanup: () => {
      registry.shutdownAll();
    },
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);
  // Apply log format BEFORE constructing any service / charge point so
  // every line that follows respects it — including "[server] xxx" setup
  // chatter via serverLog.
  setGlobalLogFormat(options.logFormat);

  // Client modes (--send/--stop/--events) target a running daemon. Resolve the
  // canonical --http-url / --http-basic-auth-* flags, but keep honoring the
  // server-side --http-host/--http-port and outgoing-WS --basic-auth-* flags
  // with a deprecation warning for backward compatibility.
  const isClientMode = options.stop || options.send !== null || options.events;
  let clientLoc: ClientLocation = {
    httpUrl: options.httpUrl ?? `http://127.0.0.1:${DEFAULT_HTTP_PORT}`,
    basicAuth: options.httpBasicAuth,
  };
  if (isClientMode) {
    const resolved = resolveClientLocation(options);
    clientLoc = resolved.location;
    for (const w of resolved.warnings) {
      process.stderr.write(`Warning: ${w}\n`);
    }
  }

  if (options.stop) {
    await stopDaemon(clientLoc);
    return;
  }

  if (options.send !== null) {
    if (!options.cpId) {
      process.stderr.write("Error: --cp-id is required for --send\n");
      process.exit(1);
    }
    await sendCommand(clientLoc, options.cpId, options.send);
    return;
  }

  if (options.events) {
    await subscribeEvents(clientLoc, options.allEvents ? null : options.cpId);
    return;
  }

  const isServerMode =
    options.daemon ||
    options.httpPort != null ||
    options.webConsolePort != null;

  if (isServerMode) {
    await startServer({
      httpPort: options.httpPort,
      httpHost: options.httpHost,
      pidPath: options.daemon ? DEFAULT_PID_PATH : null,
      bootstrap: buildBootstrap(options),
      autoConnect: !!options.cpId,
      startupScenario: options.cpId
        ? {
            scenario: options.scenario,
            scenarioTemplate: options.scenarioTemplate,
            scenarioTemplateFile: options.scenarioTemplateFile,
            scenarioConnector: options.scenarioConnector,
          }
        : null,
      cors: resolveCorsPolicy(options),
      staticDir: options.serveStatic,
      webConsolePort: options.webConsolePort,
      stateDb: options.stateDb,
      healthPath: options.healthPath,
      webConsoleBasicAuth: options.webConsoleBasicAuth,
      insecureTlsKeyPerms: options.insecureTlsKeyPerms,
    });
    return;
  }

  // REPL / JSON mode: still honour --state-db so single-CP sessions can
  // persist ChangeConfiguration overrides and queued transaction messages
  // across reruns the same way the daemon does.
  let replDatabase: Database | null = null;
  if (options.stateDb) {
    replDatabase = BunSqliteDatabase.open(options.stateDb);
  }
  const service = createStandaloneChargePointRuntime(options, replDatabase);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    service.cleanup();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (!options.jsonMode) {
    process.stdout.write(
      `OCPP CP Simulator CLI - ${options.cpId} (${options.connectors} connector(s))\n`,
    );
    process.stdout.write(`Target: ${options.wsUrl}\n`);
    process.stdout.write('Type "help" for available commands.\n\n');
  }

  if (options.jsonMode) {
    await startJsonMode(service);
  } else {
    await startRepl(service);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(
      `Fatal: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(1);
  });
}
