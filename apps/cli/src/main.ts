#!/usr/bin/env bun
import * as path from "path";
import * as fs from "fs";
import type {
  CLIOptions,
  ChargePointInitOptions,
  SoapTunnelConfig,
} from "./types";
import type { InboundValidationMode } from "@ocpp-cp-sim/core/cp/domain/charge-point/ChargePoint";
import { CLIChargePointService } from "./service";
import { startRepl } from "./repl";
import { startJsonMode } from "./jsonMode";
import { resolveClientLocation } from "./clientLocation";
import {
  isHttpUrl,
  resolveSoapCallbackUrl,
  soapCallbackUrlSuffixWarning,
} from "./soapCallbackUrl";
import { DEFAULT_SOAP_PATH } from "./soapPath";
import {
  isOff,
  resolveVehicleCatalogConfig,
  type VehicleCatalogConfig,
} from "./vehicleCatalogConfig";
import { isSoapVersion } from "@ocpp-cp-sim/core/cp/domain/types/OcppVersion";
import { hasIdPatternPlaceholder } from "@ocpp-cp-sim/contracts/index";
import {
  labelKeySchema,
  labelsSchema,
  labelValueSchema,
  normalizeLabels,
} from "@ocpp-cp-sim/contracts/labels";
import { BunSqliteDatabase } from "@ocpp-cp-sim/core/cp/domain/persistence/BunSqliteDatabase";
import type { Database } from "@ocpp-cp-sim/core/cp/domain/persistence/Database";
import { setGlobalLogFormat } from "@ocpp-cp-sim/core/cp/shared/Logger";
import { TraceWriter, setGlobalTraceWriter } from "./trace/TraceWriter";
import { parseAnalyzeArgs } from "./analyze/parseAnalyzeArgs";
import { runAnalyze } from "./analyze/runAnalyze";
import { behaviorFlagProblem } from "./behavior/flags";
import { buildBehaviorFile, parseBehaviorArgs } from "./behavior/buildBehavior";
import { BehaviorLibrary } from "./behavior/BehaviorLibrary";
import { parseExportK6Args } from "./exportK6/parseExportK6Args";
import { runExportK6 } from "./exportK6/runExportK6";
import {
  startServer,
  startupScenarioOptionConflict,
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
import { SqliteConnectorSettingsRepository } from "@ocpp-cp-sim/client/sqlite/SqliteConnectorSettingsRepository";
import {
  isOcppVersion,
  SUPPORTED_OCPP_VERSIONS,
} from "@ocpp-cp-sim/core/cp/domain/types/OcppVersion";
import { DEFAULT_BOOTSTRAP_PACING } from "./server/bootstrapPacing";
import { tlsKeyPermissionWarning } from "./tlsKeyPermissions";

/** Result of a `dist/` lookup: where it was found (if at all) and every
 *  directory that was tried, so a failure can name the paths instead of
 *  guessing at the caller's setup. */
export interface BundledDistLookup {
  /** Directory containing `index.html`, or null when nothing matched. */
  readonly dir: string | null;
  /** Absolute candidates tried, in order — verbatim material for the error. */
  readonly searched: readonly string[];
}

function hasIndexHtml(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "index.html")).isFile();
  } catch {
    // not built / not present
    return false;
  }
}

/**
 * Locate the bundled web console (Vite-built `dist/`).
 *
 * Three shapes ship this CLI and each puts `dist/` somewhere different:
 *
 * 1. **Source checkout** — `bun apps/cli/src/main.ts`. `dist/` is `<repo>/dist`
 *    once `bun run build` has run. Three levels up from `apps/cli/src/`.
 * 2. **Installed package** — the release tarball ships the CLI as one
 *    `bun build` bundle, `<pkg>/dist-cli/main.js`, beside `<pkg>/dist`
 *    (#578). One level up.
 * 3. **`bun build --compile` binary** — the Tauri sidecar. Here the module
 *    lives in the binary's virtual filesystem, so `import.meta.dir` is
 *    `/$bunfs/root` (POSIX) or `B:\~BUN\root` (Windows) and walking up
 *    from it yields `/dist`, which never exists. That was issue #319:
 *    `src-tauri/src/lib.rs` spawns the sidecar with `--web-console`, so
 *    every desktop release from v0.3.2 through v0.7.8 — about 30 of them —
 *    exited 1 the moment it started. `process.execPath` is the real
 *    on-disk path of a compiled binary, so the sidecar's neighbours are
 *    searched from there instead.
 *
 * For the desktop bundle even that is a guess (Tauri puts resources in a
 * different place on each platform), so the shell passes the directory
 * outright via `--web-console-dist` — see `src-tauri/src/lib.rs`. An
 * explicit path is authoritative: if it has no `index.html` the lookup
 * fails rather than silently falling back to some other directory.
 */
export function resolveBundledDist(
  explicit?: string | null,
): BundledDistLookup {
  if (explicit) {
    const dir = path.resolve(explicit);
    return { dir: hasIndexHtml(dir) ? dir : null, searched: [dir] };
  }

  const execDir = path.dirname(process.execPath);
  const candidates = [
    // Shape 2 (installed bundle): <pkg>/dist-cli -> <pkg>/dist. First: from
    // the bundle, two levels up is the directory holding the package
    // (node_modules/), and a stray dist/ there must not win over the
    // package's own. From a source checkout this is <repo>/apps/cli/dist, which
    // does not exist, so shape 1 is reached unchanged.
    path.resolve(import.meta.dir, "../dist"),
    // Shape 1 (source checkout): <repo>/apps/cli/src -> <repo>/dist.
    path.resolve(import.meta.dir, "../../../dist"),
    // Shape 3 (compiled): a `dist/` shipped beside or one level above the
    // binary, and the macOS .app layout where the sidecar sits in
    // Contents/MacOS/ and Tauri resources in Contents/Resources/.
    path.join(execDir, "dist"),
    path.resolve(execDir, "../dist"),
    path.resolve(execDir, "../Resources/web-console"),
  ];

  const searched: string[] = [];
  for (const candidate of candidates) {
    if (searched.includes(candidate)) continue;
    searched.push(candidate);
    if (hasIndexHtml(candidate)) return { dir: candidate, searched };
  }
  return { dir: null, searched };
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
  let cpCount = 1;
  let cpIdPattern: string | null = null;
  // Fleet startup pacing (#610); `undefined` keeps the built-in default.
  let bootstrapConcurrency: string | undefined;
  let startDelay: string | undefined;
  let startJitter: string | undefined;
  let startSeed: string | undefined;
  const labelEntries: Array<[string, string]> = [];
  let metrics = false;
  let metricsNoAuth = false;
  let watch = false;
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
  const behaviorFiles: string[] = [];
  const useBehaviors: string[] = [];
  let watchBehaviors = false;
  let allowBehaviorReload = false;
  let allowBehaviorCode = false;
  let serveStatic: string | null = null;
  // --web-console: enabled flag + optional explicit port. When the port is
  // omitted (`--web-console` alone), the UI shares the --http-port listener.
  let webConsoleEnabled = false;
  let webConsoleExplicitPort: number | null = null;
  // Explicit location of the built web console, overriding the search in
  // resolveBundledDist(). The desktop shell passes its Tauri resource dir
  // here because a compiled binary cannot find `dist/` on its own (#319).
  let webConsoleDist: string | null = null;
  let stateDb: string | null = null;
  let logFormat: "plain" | "json" = "plain";
  let healthPath = "/v1/healthz";
  const corsOrigins: string[] = [];
  let trustForwardedHeaders = false;
  const extraWsHeaders: Record<string, string> = {};
  const extraWsSubprotocols: string[] = [];
  let soapCallbackUrl: string | null = null;
  let soapPublicBaseUrl: string | null = null;
  let oedBaseUrl: string | null = null;
  let oedApiKeyFile: string | null = null;
  let soapTunnel: "none" | "ngrok" = "none";
  let soapTunnelPort: number | null = null;
  const ngrok: Record<
    "--ngrok-auth-token" | "--ngrok-domain" | "--ngrok-api-url",
    string | null
  > = {
    "--ngrok-auth-token": null,
    "--ngrok-domain": null,
    "--ngrok-api-url": null,
  };
  let soapPath: string = DEFAULT_SOAP_PATH;
  let securityProfile: CLIOptions["securityProfile"];
  let authorizationKey: string | undefined;
  let tlsCaPath: string | undefined;
  let tlsCertPath: string | undefined;
  let tlsKeyPath: string | undefined;
  let insecureTlsKeyPerms = false;
  let cpoName: string | undefined;
  let txUpdatedMeterValues = false;
  let inboundValidation: InboundValidationMode | undefined;
  let traceOutput: string | null = null;

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
      case "--cp-count":
        cpCount = parseInt(next ?? "1", 10);
        i++;
        break;
      case "--bootstrap-concurrency":
        bootstrapConcurrency = next ?? "";
        i++;
        break;
      case "--start-delay":
        startDelay = next ?? "";
        i++;
        break;
      case "--start-jitter":
        startJitter = next ?? "";
        i++;
        break;
      case "--start-seed":
        startSeed = next ?? "";
        i++;
        break;
      case "--cp-id-pattern":
        cpIdPattern = next ?? null;
        i++;
        break;
      case "--label": {
        if (!next || next.startsWith("--")) {
          process.stderr.write(
            "Error: --label requires KEY=VALUE (use multiple --label flags for several labels)\n",
          );
          process.exit(1);
        }
        // `=` cannot appear in a key, so the first one is the separator and
        // the value keeps any later `=` or `,` verbatim.
        const idx = next.indexOf("=");
        if (idx <= 0) {
          process.stderr.write(
            `Error: --label value must be KEY=VALUE, got '${next}'\n`,
          );
          process.exit(1);
        }
        const key = next.slice(0, idx);
        const value = next.slice(idx + 1);
        // Checked one by one rather than left to `labelsSchema` on the whole
        // map: the record schema drops a `__proto__` key without an issue, so
        // `--label __proto__=x` would vanish instead of being refused.
        if (!labelKeySchema.safeParse(key).success) {
          process.stderr.write(
            `Error: --label key '${key}' is invalid (${labelKeySchema.description})\n`,
          );
          process.exit(1);
        }
        if (!labelValueSchema.safeParse(value).success) {
          process.stderr.write(
            `Error: --label value for '${key}' is invalid (${labelValueSchema.description})\n`,
          );
          process.exit(1);
        }
        if (labelEntries.some(([k]) => k === key)) {
          // Last-wins would silently drop one of two values the operator
          // typed; refuse instead, like every other ambiguous startup flag.
          process.stderr.write(`Error: --label key '${key}' given twice\n`);
          process.exit(1);
        }
        labelEntries.push([key, value]);
        i++;
        break;
      }
      case "--metrics":
        metrics = true;
        break;
      case "--metrics-no-auth":
        metrics = true;
        metricsNoAuth = true;
        break;
      case "--watch":
        watch = true;
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
      case "--behavior":
        if (!next || next.startsWith("--")) {
          process.stderr.write("Error: --behavior requires a file path\n");
          process.exit(1);
        }
        behaviorFiles.push(next);
        i++;
        break;
      case "--allow-behavior-code":
        allowBehaviorCode = true;
        break;
      case "--use-behavior":
        if (!next || next.startsWith("--")) {
          process.stderr.write(
            "Error: --use-behavior requires a behavior id\n",
          );
          process.exit(1);
        }
        useBehaviors.push(next);
        i++;
        break;
      case "--watch-behaviors":
        watchBehaviors = true;
        break;
      case "--allow-behavior-reload":
        allowBehaviorReload = true;
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
      case "--trace-output":
        if (!next || next.startsWith("--")) {
          process.stderr.write("Error: --trace-output requires a file path\n");
          process.exit(1);
        }
        traceOutput = next;
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
      case "--oed-base-url":
        if (!next || next.startsWith("--")) {
          process.stderr.write("Error: --oed-base-url requires a URL\n");
          process.exit(1);
        }
        if (!isHttpUrl(next) && !isOff(next)) {
          process.stderr.write(
            "Error: --oed-base-url must be an absolute http(s) URL or none\n",
          );
          process.exit(1);
        }
        oedBaseUrl = next;
        i++;
        break;
      case "--oed-api-key-file":
        if (!next || next.startsWith("--")) {
          process.stderr.write("Error: --oed-api-key-file requires a path\n");
          process.exit(1);
        }
        oedApiKeyFile = next;
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
      case "--soap-tunnel":
        if (next !== "none" && next !== "ngrok") {
          process.stderr.write(
            "Error: --soap-tunnel must be one of: none, ngrok\n",
          );
          process.exit(1);
        }
        soapTunnel = next;
        i++;
        break;
      case "--soap-tunnel-port": {
        // Whole value, not a prefix: "9702abc" and "1e3" are mistakes.
        const port = /^\d+$/.test(next ?? "") ? Number(next) : NaN;
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          process.stderr.write(
            "Error: --soap-tunnel-port must be a port number (0 picks a free one)\n",
          );
          process.exit(1);
        }
        soapTunnelPort = port;
        i++;
        break;
      }
      case "--ngrok-auth-token":
      case "--ngrok-domain":
      case "--ngrok-api-url": {
        if (!next || next.startsWith("--")) {
          process.stderr.write(`Error: ${arg} requires a value\n`);
          process.exit(1);
        }
        if (arg === "--ngrok-api-url" && !isHttpUrl(next)) {
          process.stderr.write(
            "Error: --ngrok-api-url must be an absolute http(s) URL\n",
          );
          process.exit(1);
        }
        ngrok[arg] = next;
        i++;
        break;
      }
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
      case "--inbound-validation": {
        const value = requireFlagValue("--inbound-validation", next);
        if (value !== "off" && value !== "warn" && value !== "enforce") {
          process.stderr.write(
            "Error: --inbound-validation must be off, warn or enforce\n",
          );
          process.exit(1);
        }
        inboundValidation = value;
        i++;
        break;
      }
      case "--tx-updated-meter-values":
        txUpdatedMeterValues = true;
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
      case "--web-console-dist":
        webConsoleDist = requireFlagValue("--web-console-dist", next);
        i++;
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
    const bundled = resolveBundledDist(webConsoleDist);
    if (!bundled.dir) {
      // Name every path that was tried. The old message said only "run
      // `bun run build` in the repo first", which is useless advice to
      // someone who double-clicked a .dmg — and that is exactly who saw
      // it for 30 desktop releases (#319).
      process.stderr.write(
        "Error: --web-console could not find the built web console " +
          "(a directory containing index.html).\n" +
          bundled.searched.map((dir) => `  searched: ${dir}\n`).join("") +
          `  import.meta.dir: ${import.meta.dir}\n` +
          `  process.execPath: ${process.execPath}\n` +
          "Fixes: from a source checkout run `bun run build`; from a " +
          "release install the prebuilt tarball, which ships dist/; " +
          "otherwise pass --web-console-dist <dir>.\n",
      );
      process.exit(1);
    }
    serveStatic = bundled.dir;
    // --web-console alone is enough to put the daemon into server mode —
    // even without --http-port, the web-console port carries socket.io/health
    // alongside the UI on the same origin.
  }

  // A fleet size that is silently wrong is worse than a refused flag: a
  // non-numeric --cp-count would become NaN and bootstrap nothing, and 0 or a
  // negative would quietly bootstrap one, in both cases without saying so.
  if (!Number.isInteger(cpCount) || cpCount < 1) {
    process.stderr.write("Error: --cp-count must be a positive integer\n");
    process.exit(1);
  }
  // Same reasoning as --cp-count: a startup flag that is silently ignored is
  // worse than a refused one. `--scenario`, `--scenario-template` and
  // `--scenario-template-file` each load a definition onto every connector, so
  // two of them together is a question with no answer — and the daemon's three
  // readers of these flags used to answer it differently, which showed up as
  // restore rows held back for a scenario that was never loaded (#314).
  const startupScenarioConflict = startupScenarioOptionConflict({
    scenario,
    scenarioTemplate,
    scenarioTemplateFile,
    scenarioConnector,
  });
  if (startupScenarioConflict) {
    process.stderr.write(`Error: ${startupScenarioConflict}\n`);
    process.exit(1);
  }
  if (cpCount > 1 && !cpId) {
    // `buildBootstrap` returns null without a cpId, so the fleet would expand
    // to nothing and the daemon would start with zero charge points while
    // reporting success — the requested count silently ignored.
    process.stderr.write(
      "Error: --cp-count requires --cp-id (the fleet's id stem)\n",
    );
    process.exit(1);
  }
  // Each pair was checked as it was parsed; this adds the one rule that only
  // the whole map can break (the entry count).
  const parsedLabels = labelsSchema.safeParse(Object.fromEntries(labelEntries));
  if (!parsedLabels.success) {
    process.stderr.write(
      `Error: --label: ${parsedLabels.error.issues[0]?.message ?? "invalid labels"}\n`,
    );
    process.exit(1);
  }
  const labels = normalizeLabels(parsedLabels.data);
  if (labels && isClientMode) {
    // First, because it is the reason that holds whatever else is given:
    // `--stop` needs no --cp-id, and `--http-port` beside `--send` names the
    // daemon to talk to — the server-mode guard below would pass, as it did
    // for --watch (#314), and the client path then ignore the flag.
    process.stderr.write(
      "Error: --label cannot be combined with a client mode (--send, --stop or --events); " +
        "it labels the charge points a daemon bootstraps\n",
    );
    process.exit(1);
  }
  if (labels && !cpId) {
    // Same reasoning as --cp-count: without a cpId nothing is bootstrapped,
    // so the labels would have no charge point to land on.
    process.stderr.write(
      "Error: --label requires --cp-id (it labels the bootstrapped charge points)\n",
    );
    process.exit(1);
  }
  if (cpCount > 1 && cpIdPattern && !hasIdPatternPlaceholder(cpIdPattern)) {
    // Without a placeholder every charge point is asked for under the same id,
    // so the second create throws "already exists" and takes the daemon down
    // after a partially-started fleet. Same rule as `cp.create_many`.
    process.stderr.write(
      "Error: --cp-id-pattern must contain {n} or {n:0W}, e.g. CP{n:03}\n",
    );
    process.exit(1);
  }
  if (
    cpCount > 1 &&
    soapCallbackUrl &&
    !hasIdPatternPlaceholder(soapCallbackUrl)
  ) {
    // The daemon routes inbound SOAP calls by the cpId in the callback URL, so
    // one explicit URL cannot serve a fleet. --soap-public-base-url has no such
    // problem: it is expanded per charge point.
    process.stderr.write(
      "Error: --soap-callback-url must contain {n} when --cp-count is greater than 1 " +
        "(or use --soap-public-base-url, which is derived per charge point)\n",
    );
    process.exit(1);
  }

  const isServerMode = daemon || httpPort != null || webConsoleEnabled;

  // --soap-tunnel (#183). The ngrok options only mean something with the
  // provider selected; attach mode reads an agent someone else configured,
  // so token and domain cannot apply there. The callback server is the
  // daemon's listener, hence server mode. An explicit callback / public base
  // URL is refused alongside it: the tunnel *is* the public base.
  const ngrokApiUrl = ngrok["--ngrok-api-url"];
  const ngrokAuthToken = ngrok["--ngrok-auth-token"];
  const ngrokDomain = ngrok["--ngrok-domain"];
  let soapTunnelConfig: SoapTunnelConfig | null = null;
  if (soapTunnel === "none") {
    const stray = [
      ...Object.entries(ngrok),
      ["--soap-tunnel-port", soapTunnelPort],
    ].find(([, value]) => value != null);
    if (stray) {
      process.stderr.write(`Error: ${stray[0]} requires --soap-tunnel ngrok\n`);
      process.exit(1);
    }
  } else {
    if (ngrokApiUrl && (ngrokAuthToken || ngrokDomain)) {
      process.stderr.write(
        "Error: --ngrok-auth-token and --ngrok-domain cannot be combined with --ngrok-api-url " +
          "(attach mode uses the running agent as configured)\n",
      );
      process.exit(1);
    }
    if (ngrokApiUrl && !soapTunnelPort) {
      // The daemon can pick any free port for an agent it spawns; an agent
      // someone else runs forwards to the port it was configured with.
      process.stderr.write(
        "Error: --ngrok-api-url requires --soap-tunnel-port <port>, the port the " +
          "running agent forwards to\n",
      );
      process.exit(1);
    }
    if (!isSoapVersion(ocppVersion)) {
      process.stderr.write(
        "Error: --soap-tunnel requires a SOAP --ocpp-version (OCPP-1.2, OCPP-1.5 or OCPP-1.6S)\n",
      );
      process.exit(1);
    }
    if (!isServerMode) {
      process.stderr.write(
        "Error: --soap-tunnel requires server mode (--daemon, --http-port or --web-console); " +
          "the SOAP callback endpoint is served by the daemon\n",
      );
      process.exit(1);
    }
    const explicit = [
      ["--soap-callback-url", soapCallbackUrl],
      ["--soap-public-base-url", soapPublicBaseUrl],
    ].find(([, value]) => value != null);
    if (explicit) {
      // Two sources for the same public base is a contradiction, not a
      // precedence: the operator either knows the origin or asks for one.
      process.stderr.write(
        `Error: --soap-tunnel cannot be combined with ${explicit[0]} ` +
          "(the tunnel is what provides the public base)\n",
      );
      process.exit(1);
    }
    soapTunnelConfig = {
      provider: "ngrok",
      authToken: ngrokAuthToken,
      domain: ngrokDomain,
      apiUrl: ngrokApiUrl,
      localPort: soapTunnelPort ?? 0,
    };
  }

  if (metrics && healthPath === "/metrics") {
    // The health route is matched first, so the enabled Prometheus endpoint
    // would be unreachable while both were advertised as working.
    process.stderr.write(
      "Error: --health-path /metrics collides with the metrics endpoint\n",
    );
    process.exit(1);
  }
  if (cpCount > 1 && !isServerMode) {
    // The standalone REPL / JSON paths bootstrap exactly one charge point, so
    // the flag would be accepted and then ignored: `--cp-count 20` would run a
    // single CP and say nothing about the other nineteen.
    process.stderr.write(
      "Error: --cp-count needs a server mode (--daemon, --http-port or --web-console)\n",
    );
    process.exit(1);
  }
  // Pacing flags: a malformed number is refused rather than turned into NaN
  // (which would start the whole fleet at once, silently), and the flags need
  // a server mode and a bootstrapped fleet or they would be accepted and
  // ignored (#610).
  const pacingFlags: Array<[string, string | undefined, number, boolean]> = [
    ["--bootstrap-concurrency", bootstrapConcurrency, 1, false],
    ["--start-delay", startDelay, 0, false],
    ["--start-jitter", startJitter, 0, false],
    ["--start-seed", startSeed, 0, true],
  ];
  const pacingValues: Record<string, number> = {};
  for (const [flag, raw, min, allowNegative] of pacingFlags) {
    if (raw === undefined) continue;
    const value = /^-?\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || (!allowNegative && value < min)) {
      process.stderr.write(
        `Error: ${flag} must be ${
          allowNegative
            ? "an integer"
            : min === 1
              ? "a positive integer"
              : "a non-negative integer (milliseconds)"
        }\n`,
      );
      process.exit(1);
    }
    pacingValues[flag] = value;
    if (isClientMode) {
      // `--http-port` satisfies the server-mode check below, so without this
      // `--http-port 9700 --send … --start-delay 10` would be accepted and
      // ignored, the hole --watch (#314) and --label (#472) already close.
      process.stderr.write(
        `Error: ${flag} cannot be combined with a client mode (--send, --stop or --events); it paces the charge points a server starts\n`,
      );
      process.exit(1);
    }
    if (!isServerMode || !cpId) {
      process.stderr.write(
        `Error: ${flag} needs a server mode (--daemon, --http-port or --web-console) and --cp-id\n`,
      );
      process.exit(1);
    }
  }
  if (startSeed !== undefined && startJitter === undefined) {
    process.stderr.write(
      "Error: --start-seed has no effect without --start-jitter\n",
    );
    process.exit(1);
  }
  // setTimeout fires after 1 ms when its delay exceeds 2^31-1 ms (about 24.8
  // days), which would silently collapse the schedule for the later charge
  // points, so the last scheduled offset must stay below that.
  const MAX_TIMER_MS = 2 ** 31 - 1;
  const lastOffsetMs =
    (Math.max(cpCount, 1) - 1) * (pacingValues["--start-delay"] ?? 0) +
    (pacingValues["--start-jitter"] ?? 0);
  if (lastOffsetMs > MAX_TIMER_MS) {
    process.stderr.write(
      `Error: (--cp-count - 1) × --start-delay + --start-jitter must not exceed ${MAX_TIMER_MS} ms (about 24.8 days), got ${lastOffsetMs}\n`,
    );
    process.exit(1);
  }
  const bootstrapPacing =
    Object.keys(pacingValues).length === 0
      ? undefined
      : {
          concurrency:
            pacingValues["--bootstrap-concurrency"] ??
            DEFAULT_BOOTSTRAP_PACING.concurrency,
          startDelayMs: pacingValues["--start-delay"] ?? 0,
          startJitterMs: pacingValues["--start-jitter"] ?? 0,
          startSeed: pacingValues["--start-seed"] ?? 0,
        };
  if (labels && !isServerMode) {
    // Labels are read by `cp.list` and the console only; the standalone REPL
    // / JSON paths have neither, so the flag would be accepted and ignored.
    process.stderr.write(
      "Error: --label needs a server mode (--daemon, --http-port or --web-console)\n",
    );
    process.exit(1);
  }
  if (watch && isClientMode) {
    // Checked BEFORE the server-mode test, and separately from it, because
    // `isServerMode` is not the whole question (#314). `--send`, `--stop` and
    // `--events` return through the client path before any server is started,
    // and `--http-port` in their company names the daemon to talk to rather
    // than a port to listen on — so `--events --http-port 9000 --watch`
    // satisfied a guard that looks only at server flags and then ignored the
    // flag anyway, which is worse than no guard: it advertises a protection it
    // does not provide.
    process.stderr.write(
      "Error: --watch cannot be combined with a client mode (--send, --stop or --events); " +
        "it configures the daemon being talked to, not the client talking to it\n",
    );
    process.exit(1);
  }
  if (watch && !isServerMode) {
    // Same reasoning as --cp-count above: the file watcher lives in the
    // daemon, so outside a server mode the flag would be accepted and then do
    // nothing at all. #295's review settled that a flag which cannot take
    // effect is an error rather than silence.
    process.stderr.write(
      "Error: --watch needs a server mode (--daemon, --http-port or --web-console)\n",
    );
    process.exit(1);
  }

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

  const behaviorProblem = behaviorFlagProblem({
    serverMode: isServerMode,
    behaviorFiles,
    allowBehaviorCode,
    unsafeRemote,
    useBehaviors,
    watchBehaviors,
    allowBehaviorReload,
  });
  if (behaviorProblem) {
    process.stderr.write(`${behaviorProblem}\n`);
    process.exit(1);
  }
  if (
    isClientMode &&
    (behaviorFiles.length > 0 ||
      allowBehaviorCode ||
      useBehaviors.length > 0 ||
      watchBehaviors ||
      allowBehaviorReload)
  ) {
    process.stderr.write(
      "Error: --behavior, --allow-behavior-code, --use-behavior and " +
        "--watch-behaviors and --allow-behavior-reload apply to a running charge point, not to " +
        "--send / --stop / --events\n",
    );
    process.exit(1);
  }
  if (useBehaviors.length > 0 && !cpId) {
    // Same reasoning as --label: without a cpId nothing is bootstrapped, so
    // the selection would have no charge point to land on.
    process.stderr.write(
      "Error: --use-behavior requires --cp-id (it selects the behaviors of the bootstrapped charge points)\n",
    );
    process.exit(1);
  }

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
  // wins; otherwise --soap-public-base-url derives it. With --soap-tunnel the
  // public base is only known once the tunnel is up, so main() resolves it
  // then — see soapCallbackUrl.ts for the ladder.
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
  if (isSoapVersion(ocppVersion) && resolvedSoapCallbackUrl) {
    const suffixWarning = soapCallbackUrlSuffixWarning(resolvedSoapCallbackUrl);
    if (suffixWarning) {
      process.stderr.write(`Warning: ${suffixWarning}\n`);
    }
  }

  return {
    wsUrl,
    cpId,
    cpCount,
    cpIdPattern,
    bootstrapPacing,
    labels,
    metrics,
    metricsNoAuth,
    watch,
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
    behaviorFiles,
    allowBehaviorCode,
    useBehaviors,
    watchBehaviors,
    allowBehaviorReload,
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
    soapCallbackUrlExplicit: soapCallbackUrl,
    soapPublicBaseUrl,
    oedBaseUrl,
    oedApiKeyFile,
    soapTunnel: soapTunnelConfig,
    soapPath,
    securityProfile,
    authorizationKey,
    cpoName,
    ...(txUpdatedMeterValues ? { txUpdatedMeterValues } : {}),
    ...(inboundValidation ? { inboundValidation } : {}),
    tls,
    tlsCaPath,
    tlsCertPath,
    tlsKeyPath,
    insecureTlsKeyPerms,
    traceOutput,
  };
}

/**
 * #458: the daemon's Open EV Directory settings, from the flags and the
 * environment. A broken setting (an unreadable key file, a malformed
 * OED_BASE_URL) stops the daemon rather than starting with import silently
 * disabled; a key without a URL only warns.
 */
function vehicleCatalogConfigOrExit(
  options: CLIOptions,
): VehicleCatalogConfig | null {
  const result = resolveVehicleCatalogConfig({
    flagBaseUrl: options.oedBaseUrl,
    flagApiKeyFile: options.oedApiKeyFile,
    env: process.env,
    readFile: (file) => fs.readFileSync(file, "utf8"),
  });
  if (!result.ok) {
    process.stderr.write(`Error: ${result.message}\n`);
    process.exit(1);
  }
  for (const warning of result.warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }
  return result.config;
}

function printUsage(): void {
  process.stderr.write(`
Usage: ocpp-cp-sim [options]    (or "bun apps/cli/src/main.ts [options]" from a checkout)

Local modes (single CP, no server):
  --cp-id <id> --ws-url <url>                Interactive REPL (default)
  --cp-id <id> --ws-url <url> --json         JSON Lines mode

Server modes (HTTP/WebSocket, multi-CP):
  --daemon [--cp-id X --ws-url Y]                  Background TCP server (127.0.0.1:${DEFAULT_HTTP_PORT})
  --cp-count N [--cp-id-pattern CP{n:03}]          Bootstrap N charge points instead of one
  --label KEY=VALUE                                Label every bootstrapped charge point (repeatable)
  --metrics [--metrics-no-auth]                    Serve Prometheus text exposition at GET /metrics
  --watch                                          Re-read loaded idTag and scenario files when they change
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
  --cp-count <n>           Server mode: bootstrap N charge points instead of
                           one, sharing every option but the id. Requires
                           --cp-id as the id stem and a server mode.
  --cp-id-pattern <tpl>    Id template used with --cp-count (default:
                           <cp-id>{n:03}). {n} is the index, {n:03} zero-pads
                           it.
  --bootstrap-concurrency <n>
                           Server mode: charge points started at once
                           (default: 8).
  --start-delay <ms>       Server mode: milliseconds between the scheduled
                           starts of consecutive charge points (default: 0).
  --start-jitter <ms>      Server mode: push each start back by a seeded
                           random 0..ms-1 (default: 0).
  --start-seed <n>         Server mode: seed of --start-jitter (default: 0); the same seed
                           gives the same schedule.
  --label <key=value>      Server mode: label every bootstrapped charge point.
                           Repeatable; split on the first '='. Requires
                           --cp-id. A charge point restored from --state-db
                           keeps its stored labels.
  --security-profile <0|1|2|3>
                           OCPP 1.6 security profile. 0 leaves transport/auth
                           as configured; 1 adds AuthorizationKey Basic Auth
                           and keeps the configured ws:// or wss:// scheme;
                           2 forces wss:// + AuthorizationKey Basic Auth +
                           verified server cert; 3 forces wss:// mTLS and
                           suppresses Basic Auth. Profiles never downgrade
                           wss:// to ws://.
  --authorization-key <hex> AuthorizationKey used as Basic Auth password for
                           security profiles 1 and 2 (username is CP ID).
  --tls-ca <path>          PEM CA bundle used to verify the CSMS server cert.
  --tls-cert <path>        PEM client certificate for profile 3 mTLS.
  --tls-key <path>         PEM client private key for profile 3 mTLS.
                           Must be mode 0600 unless
                           --insecure-tls-key-perms is passed.
  --insecure-tls-key-perms Allow --tls-key files readable by group/other.
  --cpo-name <name>        CPO name for generated SignCertificate CSRs.
  --inbound-validation <off|warn|enforce>
                           OCPP 1.6J: what to do with an inbound CALL whose
                           payload breaks the request schema. warn (default)
                           logs and traces the violation and runs the handler;
                           enforce answers a CALLERROR; off skips the check.
  --tx-updated-meter-values
                           OCPP 2.x: send the periodic meter samples taken
                           during a transaction as TransactionEvent(Updated,
                           MeterValuePeriodic) instead of MeterValues.
                           Off by default.
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
  --header KEY:VALUE       Extra header on the outgoing CP -> CSMS WebSocket
                           upgrade. Repeatable.
  --ws-subprotocol <value> Extra subprotocol offered on the outgoing
                           CP -> CSMS WebSocket upgrade. Repeatable.
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
  --behavior <file>        Load behavior code (a TypeScript or JavaScript
                           module whose default export is a behavior) onto
                           every charge point (repeatable). It runs with this
                           process's full authority; see docs/entities/cli.md.
  --allow-behavior-code    A daemon's explicit opt-in to --behavior. Refused
                           together with --unsafe-remote.
  --use-behavior <id>      Run only the loaded behavior with this id on the
                           charge points started from --cp-id (repeatable;
                           default: every --behavior). Charge points created
                           later pick theirs with the "behaviors" parameter
                           or cp.behaviors.set; ids only, never code.
  --watch-behaviors        Reload a --behavior file when it (or a file in its
                           directory) changes: new calls use the new code,
                           exchanges in flight finish on the old one, ctx.state
                           stays. A file that does not build keeps the old
                           version. Daemon: also enables the behavior.reload
                           method.
  --allow-behavior-reload  Daemon only: answer the behavior.reload method
                           (re-reads the --behavior files, runs their code)
                           without watching them. Without this flag or
                           --watch-behaviors the method is refused and new
                           code enters only at start.
  --cors-origin <origin>   Restrict CORS to this origin (repeatable). Pass "*"
                           for open CORS. Default: open on a loopback bind;
                           same-origin-only when bound to a non-loopback host
                           (0.0.0.0 / LAN) so cross-site browser calls are
                           rejected, and also same-origin-only with
                           --allow-behavior-code, on any bind (a page in
                           your browser must not drive a daemon that runs
                           code; a web console on another origin then needs
                           --cors-origin <its origin>).
  --trust-forwarded-headers
                           With the same-origin default, also accept the
                           public origin a reverse proxy reports via
                           X-Forwarded-Proto / X-Forwarded-Host. Use only
                           behind a trusted proxy (see docs/concepts/access-control.md).
  --web-console [<port>]   Serve the bundled browser UI alongside socket.io.
                           With <port>: opens a second listener on that port.
                           Without <port>: shares the --http-port listener.
                           Requires the UI to be built (run "bun run build",
                           or use an installed package which ships dist/).
  --web-console-dist <dir>
                           Serve the web console from this directory instead
                           of searching for a bundled dist/. Must contain
                           index.html. The desktop app passes its Tauri
                           resource dir here (docs/entities/desktop-app.md).
  --state-db <path>        Persist Configuration overrides, charging-profile
                           state, scenarios, and pending transaction
                           messages to a SQLite file (or ":memory:").
                           Without this flag the daemon is fully in-memory
                           and forgets everything at exit.
  --log-format <fmt>       "plain" (default) or "json" — output one JSON
                           object per stderr line for structured-log
                           collectors (Loki, jq, etc.).
  --trace-output <path>    Append every OCPP wire message as a JSONL trace
                           record (docs/concepts/trace-format.md) — works in REPL,
                           JSON, and daemon modes.
  analyze <trace.jsonl> [--output <file>] [--format html|markdown]
          [--split-by charge-point|connector]
                           Analyze a trace with OCPP DebugKit and write a
                           report.
  analyze --from-daemon --cp-id <id> [--http-url <url>]
          [--http-basic-auth-user <u> --http-basic-auth-pass <p>]
          [--output <file>] [--format html|markdown]
          [--split-by charge-point|connector]
                           Same report, built from a running daemon's stored
                           logs (the logs.get RPC) instead of a trace file --
                           no --trace-output needed, and no daemon restart.
                           --cp-id is required (logs.get is scoped to one
                           charge point); --http-url defaults to
                           http://127.0.0.1:${DEFAULT_HTTP_PORT}, matching
                           the other client modes (--send/--stop/--events).
                           --split-by connector further splits each charge
                           point's report by connector (default:
                           charge-point, i.e. current behavior). See
                           docs/entities/analyze.md -> "Splitting by
                           connector" for what gets replicated into every
                           connector's report and why.
  behavior build <file> [--out <file>]
                           Type-check a behavior and bundle it (ES2017, k6/* external).
  export-k6 (--scenario <file.json> | --behavior <file>...) [-o <dir>] [--ocpp-version 1.6] [--force]
                           Export a scenario, or behavior code (OCPP 1.6J),
                           as a runnable k6 load-test bundle (entry script +
                           self-contained OCPP runtime + README). Requires
                           k6 >= v1.6 to run the generated test. See
                           docs/entities/cli.md -> export-k6.
  --health-path <path>     Absolute path the health-check JSON is served on
                           (default: /v1/healthz). Change this when running
                           behind a proxy that reserves the default path
                           (e.g. Cloud Run / GFE). The browser UI build must
                           be given the matching VITE_HEALTH_PATH so its
                           remote-mode auto-detect probe lines up.
  --metrics                Server mode: serve GET /metrics (Prometheus text
                           exposition). Off by default; behind the same
                           Basic Auth gate as the rest of the HTTP surface
                           unless --metrics-no-auth is also passed. Refused
                           together with --health-path /metrics.
  --metrics-no-auth        Implies --metrics and serves it outside the
                           Basic Auth gate. Trusted networks only.
  --watch                  Server mode: re-read the idTag and scenario files
                           this daemon loaded when they change on disk,
                           debounced. A parse failure keeps the previous good
                           copy. An idTag pool applies live -- it is drawn once
                           per session, so an open transaction keeps the tag it
                           presented and the next draw sees the new list. A
                           scenario reload is held while that connector has an
                           open transaction or a run of it is in flight, and
                           applied when that session ends. Off by default;
                           refused outside a server mode and alongside
                           --send/--stop/--events.
  --soap-callback-url <url>
                           SOAP ChargePointService callback URL for OCPP 1.2, 1.5,
                           or 1.6S. Required for SOAP versions unless
                           --soap-public-base-url is given instead.
  --soap-public-base-url <url>
                           Public base URL (e.g. a tunnel origin) the CSMS can
                           reach; the full callback URL is derived as
                           {base}{soap-path}/{cp-id}/ChargePointService. An
                           explicit --soap-callback-url takes precedence.
  --soap-tunnel <none|ngrok>
                           Expose the SOAP callback endpoint through a tunnel
                           and derive the callback URL from its public origin
                           (default: none). Server mode only; cannot be
                           combined with --soap-callback-url or
                           --soap-public-base-url. ngrok runs the ngrok binary
                           from PATH; the public URL is logged at startup and
                           reported by the server.info RPC, and every SOAP
                           charge point created without a callback URL gets
                           one derived from it. The tunnel forwards to a
                           dedicated listener that serves the callback route
                           only; socket.io, the web console and MCP stay on the
                           local listeners.
  --soap-tunnel-port <port>
                           Local port of that dedicated listener (default: 0,
                           a free port). Required with --ngrok-api-url: the
                           running agent forwards to the port it was
                           configured with.
  --ngrok-auth-token <token>
                           ngrok authtoken, handed to the agent through its
                           environment (never on its command line or in logs).
                           Without it the agent uses NGROK_AUTHTOKEN or its
                           own config file.
  --ngrok-domain <domain>  Reserved ngrok domain to request (ngrok http --url).
                           Free-tier URLs change between runs.
  --ngrok-api-url <url>    Attach to an already-running ngrok agent (e.g. a
                           Docker sidecar: http://ngrok:4040) instead of
                           spawning one; the https tunnel forwarding to the
                           listener port is used. Incompatible with the two
                           options above.
  --soap-path <path>       Base path reserved for the SOAP callback server
                           (default: /ocpp/soap).
                           OCPP-S has no per-message auth: on the daemon's
                           listeners rely on --web-console-basic-auth-* or a
                           trusted network; the --soap-tunnel listener has
                           neither, only the route's identity check, so put a
                           boundary (ngrok traffic policy, allow-list) in front.
  --oed-base-url <url|none>
                           Open EV Directory API to import vehicle profiles
                           from (server mode). Also OED_BASE_URL. Default: the
                           public https://evdb.juherr.dev, called only when a
                           user imports; none turns import off. The console
                           imports through the daemon, so the API key stays
                           on the server.
  --oed-api-key-file <path>
                           File holding your personal Open EV Directory API
                           key (optional: the catalog is anonymous; keys are
                           provisioned by its operator, see
                           https://github.com/juherr/open-ev-directory#api-keys).
                           Also OED_API_KEY_FILE, or the key itself in
                           OED_API_KEY. There is no flag taking the key: a
                           command line is visible in ps.
  -h, --help               Show this help

HTTP endpoints (see docs/entities/daemon.md):
  GET    /v1/healthz       (or whatever --health-path is set to)
  GET    /socket.io/       Socket.IO / Engine.IO transport
  POST   /socket.io/       Socket.IO / Engine.IO transport
  POST   /mcp             MCP (Model Context Protocol) Streamable HTTP endpoint
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
function resolveCorsPolicy(options: CLIOptions):
  | { kind: "any" }
  | { kind: "allowlist"; origins: string[] }
  | {
      kind: "same-origin";
      trustForwardedHeaders: boolean;
      allowedHosts?: string[];
    } {
  if (options.corsOrigins.length > 0) {
    if (options.corsOrigins.length === 1 && options.corsOrigins[0] === "*") {
      return { kind: "any" };
    }
    return { kind: "allowlist", origins: [...options.corsOrigins] };
  }
  const host = options.httpHost;
  if (options.allowBehaviorCode) {
    process.stderr.write(
      "[server] --allow-behavior-code: applying same-origin-only CORS, so a " +
        "page from another origin cannot call /socket.io or /mcp, and a Host " +
        "that is not an IP address, localhost or the bind address is refused " +
        "(DNS rebinding). A web " +
        "console served from another origin needs `--cors-origin <origin>`; " +
        '`--cors-origin "*"` opens it again.\n',
    );
    return {
      kind: "same-origin",
      trustForwardedHeaders: options.trustForwardedHeaders,
      // Against DNS rebinding: the Host must be an IP literal, localhost or
      // the name the daemon was told to bind to.
      allowedHosts: [host],
    };
  }
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

/**
 * The charge point `--cp-id` and its companion flags describe; the daemon's
 * `expandBootstrap` turns it into the `--cp-count` fleet. Exported for tests.
 */
export function buildBootstrap(
  options: CLIOptions,
): ChargePointInitOptions | null {
  if (!options.cpId) return null;
  return {
    cpId: options.cpId,
    wsUrl: options.wsUrl,
    centralSystemUrl: options.wsUrl,
    connectors: options.connectors,
    vendor: options.vendor,
    model: options.model,
    ocppVersion: options.ocppVersion,
    // Only an explicit --soap-callback-url travels with the charge point; a
    // --soap-public-base-url / --soap-tunnel origin is handed to the registry,
    // which derives (and never persists) the URL at instantiation (#183).
    soapCallbackUrl: options.soapCallbackUrlExplicit ?? undefined,
    soapPath: options.soapPath,
    basicAuth: options.basicAuth,
    extraWsHeaders: options.extraWsHeaders,
    extraWsSubprotocols: options.extraWsSubprotocols,
    securityProfile: options.securityProfile,
    authorizationKey: options.authorizationKey,
    cpoName: options.cpoName,
    ...(options.txUpdatedMeterValues ? { txUpdatedMeterValues: true } : {}),
    ...(options.inboundValidation
      ? { inboundValidation: options.inboundValidation }
      : {}),
    ...((options.useBehaviors?.length ?? 0) > 0
      ? { behaviors: [...options.useBehaviors!] }
      : {}),
    tls: options.tls,
    tlsCaPath: options.tlsCaPath,
    tlsCertPath: options.tlsCertPath,
    tlsKeyPath: options.tlsKeyPath,
    labels: options.labels,
  };
}

async function loadBehavesOrExit(
  files: readonly string[],
  useBehaviors: readonly string[] = [],
): Promise<BehaviorLibrary> {
  if (files.length === 0) return BehaviorLibrary.of([]);
  try {
    const library = await BehaviorLibrary.fromFiles(files);
    library.check(useBehaviors);
    return library;
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

function createStandaloneChargePointRuntime(
  options: CLIOptions,
  database: Database | null,
  behaviors: BehaviorLibrary = BehaviorLibrary.of([]),
): SingleCpRuntimeTarget {
  const bootstrap = buildBootstrap(options);
  if (!bootstrap) {
    throw new Error("cpId is required");
  }

  const bus = new EventBus();
  const registry = new CPRegistry(bus, database, {
    allowInsecureTlsKeyPerms: options.insecureTlsKeyPerms,
    behaviors,
  });
  const configRepository = createSocketConfigRepository(database);
  // #495: the registry's, which its charge points write to as well.
  const scenarioRepository = registry.scenarioDefinitions;
  const connectorSettingsRepository = new SqliteConnectorSettingsRepository(
    database,
  );
  const chargePointService = new RegistryChargePointService(registry, {
    database,
    configRepository,
    scenarioRepository,
    connectorSettingsRepository,
  });
  const standalone = CLIChargePointService.fromOptions(options, database);
  standalone.loadBehaviors(
    behaviors.select(
      (options.useBehaviors?.length ?? 0) > 0
        ? options.useBehaviors
        : undefined,
    ),
  );
  const eventSource = registry.registerExisting(standalone);

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
  // `analyze` is a subcommand, not a flag combination: it never bootstraps a
  // charge point, so it is dispatched before parseArgs() (which requires
  // --cp-id/--ws-url or a server mode) even sees argv. Its own small parser
  // lives in ./analyze/parseAnalyzeArgs so the flag edge cases are unit
  // testable without spawning a subprocess per case.
  if (process.argv[2] === "analyze") {
    const parsed = parseAnalyzeArgs(process.argv.slice(3));
    if (!parsed.ok) {
      process.stderr.write(`${parsed.message}\n`);
      process.exit(1);
    }
    const code = await runAnalyze(parsed.args);
    process.exit(code);
  }

  // `export-k6`, like `analyze`, is a subcommand: it never bootstraps a
  // charge point, so it is dispatched before parseArgs().
  if (process.argv[2] === "export-k6") {
    const parsed = parseExportK6Args(process.argv.slice(3));
    if (!parsed.ok) {
      process.stderr.write(`${parsed.message}\n`);
      process.exit(1);
    }
    const code = await runExportK6(parsed.args);
    process.exit(code);
  }

  // `behavior build` is a subcommand like `export-k6`.
  if (process.argv[2] === "behavior") {
    const parsed = parseBehaviorArgs(process.argv.slice(3));
    if (!parsed.ok) {
      process.stderr.write(`${parsed.message}\n`);
      process.exit(1);
    }
    const result = await buildBehaviorFile(parsed.file, parsed.out);
    if (!result.ok) {
      process.stderr.write(
        `Error: cannot build ${parsed.file}:\n  ${result.problems.join("\n  ")}\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`${result.outFile}\n`);
    process.exit(0);
  }

  const options = parseArgs(process.argv);
  // Apply log format BEFORE constructing any service / charge point so
  // every line that follows respects it — including "[server] xxx" setup
  // chatter via serverLog.
  setGlobalLogFormat(options.logFormat);

  // --trace-output (#188): construct the global TraceWriter before any CP is
  // built (CLIChargePointService.attach()es to it in its constructor, so
  // every mode's CP -- standalone, daemon create/restore/update -- picks it
  // up uniformly). A bad path (missing parent dir, no permission) must fail
  // loudly at startup rather than silently losing every trace record.
  if (options.traceOutput) {
    try {
      const traceWriter = new TraceWriter(options.traceOutput);
      setGlobalTraceWriter(traceWriter);
    } catch (err) {
      process.stderr.write(
        `Error: cannot write trace output: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      process.exit(1);
    }
  }

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
    const behaviors = await loadBehavesOrExit(
      options.behaviorFiles,
      options.useBehaviors,
    );
    await startServer({
      behaviors,
      watchBehaviors: options.watchBehaviors,
      allowBehaviorReload: options.allowBehaviorReload,
      allowBehaviorCode: options.allowBehaviorCode,
      httpPort: options.httpPort,
      httpHost: options.httpHost,
      pidPath: options.daemon ? DEFAULT_PID_PATH : null,
      bootstrap: buildBootstrap(options),
      bootstrapCount: options.cpCount,
      bootstrapIdPattern: options.cpIdPattern ?? undefined,
      bootstrapPacing: options.bootstrapPacing,
      soapCallbackUrlExplicit: options.soapCallbackUrlExplicit,
      soapPublicBaseUrl: options.soapPublicBaseUrl,
      soapPath: options.soapPath,
      soapTunnel: options.soapTunnel,
      metrics: options.metrics,
      metricsNoAuth: options.metricsNoAuth,
      watch: options.watch,
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
      vehicleCatalog: vehicleCatalogConfigOrExit(options),
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
  const behaviors = await loadBehavesOrExit(
    options.behaviorFiles,
    options.useBehaviors,
  );
  if (options.watchBehaviors) behaviors.watch();
  const service = createStandaloneChargePointRuntime(
    options,
    replDatabase,
    behaviors,
  );

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
