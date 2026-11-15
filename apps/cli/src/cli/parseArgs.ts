import type { CLIOptions, SoapTunnelConfig } from "../types";
import type { InboundValidationMode } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import {
  isHttpUrl,
  resolveSoapCallbackUrl,
  soapCallbackUrlSuffixWarning,
} from "../soapCallbackUrl";
import { DEFAULT_SOAP_PATH } from "../soapPath";
import { isOff } from "../vehicleCatalogConfig";
import { isSoapVersion } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import { hasIdPatternPlaceholder } from "@ocpp-cp-simulator/contracts/index";
import {
  labelKeySchema,
  labelsSchema,
  labelValueSchema,
  normalizeLabels,
} from "@ocpp-cp-simulator/contracts/labels";
import { behaviorFlagProblem } from "../behavior/flags";
import { collectBehaviorParams } from "../behavior/paramsFlag";
import type { JsonObject } from "@ocpp-cp-simulator/contracts/behavior";
import {
  startupScenarioOptionConflict,
  DEFAULT_HTTP_PORT,
} from "../server/startServer";
import {
  DEFAULT_RATE_LIMIT_MAX_IPS,
  parseTrustedProxy,
} from "../server/accessGuard";
import { parseLogLevel, parseSize } from "../logSink";
import { CP_BULK_WAIT_MS } from "@ocpp-cp-simulator/contracts/limits";
import { isOcppVersion } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import { DEFAULT_BOOTSTRAP_PACING } from "../server/bootstrapPacing";
import { tlsKeyPermissionWarning } from "../tlsKeyPermissions";
import { cliModuleDir, resolveBundledDist } from "../bundledDist";
import {
  OCPP_VERSION_VALUES,
  parseSecurityProfile,
  requireNumberFlag,
  requireFlagValue,
  readPemFile,
  isLoopbackHost,
} from "./flagValues";
import { parseTransportFlags } from "./transportFlags";
import { printUsage } from "./usage";

export function parseArgs(argv: string[]): CLIOptions {
  let wsUrl = "";
  let cpId: string | null = null;
  let cpCount = 1;
  let cpIdPattern: string | null = null;
  const fleetTemplateFiles: string[] = [];
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
  const behaviorParamSpecs: string[] = [];
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
  const allowedHosts: string[] = [];
  const trustedProxies: string[] = [];
  let requireTls = false;
  let rateLimitPerIp = 0;
  let rateLimitMaxIps = DEFAULT_RATE_LIMIT_MAX_IPS;
  let logLevel: CLIOptions["logLevel"] = null;
  let logFile: string | null = null;
  let logMaxBytes: number | null = null;
  let logRotateDaily = false;
  let logKeep = 5;
  let shutdownStopTransactions = false;
  let shutdownWaitMs = 5000;
  let connectRestored = true;
  let cpBulkWaitMs = CP_BULK_WAIT_MS;
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
  let txUpdatedMeterValues: boolean | undefined;
  let inboundValidation: InboundValidationMode | undefined;
  let reservationAuthorizeIdTag = false;
  // #609: reconnect flags collect here and are validated as one object below.
  const reconnect: Record<string, number | string> = {};
  // #611: `--ws-*` flags, validated with the reconnect ones.
  const wsFlags: Record<string, number | string | boolean> = {};
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
      case "--fleet-template":
        if (!next || next.startsWith("--")) {
          process.stderr.write("Error: --fleet-template needs a file path\n");
          process.exit(1);
        }
        fleetTemplateFiles.push(next);
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
      case "--behavior-params":
        if (!next || next.startsWith("--")) {
          process.stderr.write(
            "Error: --behavior-params requires <id>=<json file or inline json>\n",
          );
          process.exit(1);
        }
        behaviorParamSpecs.push(next);
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
      case "--allowed-host":
        if (!next || next.startsWith("--")) {
          process.stderr.write("Error: --allowed-host requires a host name\n");
          process.exit(1);
        }
        allowedHosts.push(next);
        i++;
        break;
      case "--trusted-proxy":
        if (!next || next.startsWith("--") || !parseTrustedProxy(next)) {
          process.stderr.write(
            "Error: --trusted-proxy requires an IP address or CIDR (for example 10.0.0.0/8)\n",
          );
          process.exit(1);
        }
        trustedProxies.push(next);
        i++;
        break;
      case "--require-tls":
        requireTls = true;
        break;
      case "--rate-limit-per-ip":
      case "--rate-limit-max-ips":
      case "--log-keep":
      case "--shutdown-wait-ms":
      case "--cp-bulk-wait-ms": {
        const value = Number(next);
        const min = arg === "--rate-limit-max-ips" ? 1 : 0;
        if (!next || !/^\d+$/.test(next) || value < min) {
          process.stderr.write(
            `Error: ${arg} requires a whole number >= ${min}\n`,
          );
          process.exit(1);
        }
        if (arg === "--rate-limit-per-ip") rateLimitPerIp = value;
        else if (arg === "--rate-limit-max-ips") rateLimitMaxIps = value;
        else if (arg === "--log-keep") logKeep = value;
        else if (arg === "--shutdown-wait-ms") shutdownWaitMs = value;
        else cpBulkWaitMs = value;
        i++;
        break;
      }
      case "--log-level": {
        const level = parseLogLevel(next);
        if (!level) {
          process.stderr.write(
            "Error: --log-level must be debug, info, warn or error\n",
          );
          process.exit(1);
        }
        logLevel = level;
        i++;
        break;
      }
      case "--log-file":
        if (!next || next.startsWith("--")) {
          process.stderr.write("Error: --log-file requires a file path\n");
          process.exit(1);
        }
        logFile = next;
        i++;
        break;
      case "--log-max-size": {
        const bytes = parseSize(next);
        if (bytes === null) {
          process.stderr.write(
            "Error: --log-max-size requires a size such as 10m, 512k or 1048576\n",
          );
          process.exit(1);
        }
        logMaxBytes = bytes;
        i++;
        break;
      }
      case "--log-rotate-daily":
        logRotateDaily = true;
        break;
      case "--shutdown-stop-transactions":
        shutdownStopTransactions = true;
        break;
      case "--no-connect-restored":
        connectRestored = false;
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
      case "--reservation-authorize-id-tag":
        reservationAuthorizeIdTag = true;
        break;
      case "--reconnect-max-attempts":
        reconnect.maxAttempts = requireNumberFlag(arg, next, {
          integer: true,
          min: -1,
        });
        i++;
        break;
      case "--reconnect-mode": {
        const mode = requireFlagValue(arg, next);
        if (mode !== "exponential" && mode !== "fixed") {
          process.stderr.write(
            'Error: --reconnect-mode must be "exponential" or "fixed"\n',
          );
          process.exit(1);
        }
        reconnect.mode = mode;
        i++;
        break;
      }
      case "--reconnect-base-delay-ms":
        reconnect.baseDelayMs = requireNumberFlag(arg, next, { min: 0 });
        i++;
        break;
      case "--reconnect-max-delay-ms":
        reconnect.maxDelayMs = requireNumberFlag(arg, next, { min: 0 });
        i++;
        break;
      case "--reconnect-jitter-ms":
        reconnect.jitterMs = requireNumberFlag(arg, next, { min: 0 });
        i++;
        break;
      case "--ws-handshake-timeout-ms":
        wsFlags.handshakeTimeoutMs = requireNumberFlag(arg, next, {
          min: 1,
        });
        i++;
        break;
      case "--ws-no-compression":
        wsFlags.perMessageDeflate = false;
        break;
      case "--ws-max-payload":
        wsFlags.maxPayloadBytes = requireNumberFlag(arg, next, {
          integer: true,
          min: 1,
        });
        i++;
        break;
      case "--ws-proxy":
        wsFlags.proxy = requireFlagValue(arg, next);
        i++;
        break;
      case "--ws-local-address":
        wsFlags.localAddress = requireFlagValue(arg, next);
        i++;
        break;
      case "--boot-retry-limit":
        reconnect.bootRetryLimit = requireNumberFlag(arg, next, {
          integer: true,
          min: -1,
        });
        i++;
        break;
      case "--tx-updated-meter-values":
        txUpdatedMeterValues = true;
        break;
      case "--no-tx-updated-meter-values":
        txUpdatedMeterValues = false;
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
          `  import.meta.dir: ${cliModuleDir()}\n` +
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
  if (fleetTemplateFiles.length > 0 && !isServerMode) {
    // Templates are served and instantiated by the daemon; outside a server
    // mode the flag would be accepted and ignored.
    process.stderr.write(
      "Error: --fleet-template needs a server mode (--daemon, --http-port or --web-console)\n",
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
  let behaviorParams: Record<string, JsonObject> = {};
  try {
    behaviorParams = collectBehaviorParams(behaviorParamSpecs);
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
  if (isClientMode && behaviorParamSpecs.length > 0) {
    process.stderr.write(
      "Error: --behavior-params applies to a running charge point, not to --send / --stop / --events\n",
    );
    process.exit(1);
  }
  if (behaviorParamSpecs.length > 0 && !cpId) {
    process.stderr.write(
      "Error: --behavior-params requires --cp-id (it sets the params of the bootstrapped charge points)\n",
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

  // The daemon speaks plain HTTP: it can only learn that a remote client used
  // TLS from a proxy it trusts, so the requirement is unsatisfiable without one.
  if (
    !isClientMode &&
    isServerMode &&
    requireTls &&
    !isLoopbackHost(httpHost) &&
    trustedProxies.length === 0
  ) {
    process.stderr.write(
      "Error: --require-tls on a non-loopback bind needs --trusted-proxy: the " +
        "daemon itself speaks plain HTTP and learns about TLS from the proxy " +
        "in front of it.\n",
    );
    process.exit(1);
  }

  // On a loopback bind a same-host reverse proxy reaches the daemon from
  // 127.0.0.1, which counts as a direct local caller unless the proxy is
  // listed, so --require-tls would let its plain-HTTP clients through.
  if (
    !isClientMode &&
    isServerMode &&
    requireTls &&
    isLoopbackHost(httpHost) &&
    trustedProxies.length === 0
  ) {
    process.stderr.write(
      "Warning: --require-tls without --trusted-proxy only constrains " +
        "clients that connect from another host. Behind a reverse proxy on " +
        "this host, add --trusted-proxy 127.0.0.1 so the proxy has to report " +
        "https.\n",
    );
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
    fleetTemplateFiles,
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
    behaviorParams,
    watchBehaviors,
    allowBehaviorReload,
    corsOrigins,
    trustForwardedHeaders,
    allowedHosts,
    trustedProxies,
    requireTls,
    rateLimitPerIp,
    rateLimitMaxIps,
    logLevel,
    logFile,
    logMaxBytes,
    logRotateDaily,
    logKeep,
    shutdownStopTransactions,
    shutdownWaitMs,
    connectRestored,
    cpBulkWaitMs,
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
    ...(txUpdatedMeterValues !== undefined ? { txUpdatedMeterValues } : {}),
    ...(inboundValidation ? { inboundValidation } : {}),
    ...(reservationAuthorizeIdTag ? { reservationAuthorizeIdTag } : {}),
    ...(Object.keys(reconnect).length > 0 || Object.keys(wsFlags).length > 0
      ? { transport: parseTransportFlags(reconnect, wsFlags, ocppVersion) }
      : {}),
    tls,
    tlsCaPath,
    tlsCertPath,
    tlsKeyPath,
    insecureTlsKeyPerms,
    traceOutput,
  };
}
