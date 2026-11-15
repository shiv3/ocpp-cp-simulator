import type { CLIOptions, SoapTunnelConfig } from "../types";
import {
  resolveSoapCallbackUrl,
  soapCallbackUrlSuffixWarning,
} from "../soapCallbackUrl";
import { isSoapVersion } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import { hasIdPatternPlaceholder } from "@ocpp-cp-simulator/contracts/index";
import {
  labelsSchema,
  normalizeLabels,
} from "@ocpp-cp-simulator/contracts/labels";
import { behaviorFlagProblem } from "../behavior/flags";
import { collectBehaviorParams } from "../behavior/paramsFlag";
import type { JsonObject } from "@ocpp-cp-simulator/contracts/behavior";
import {
  startupScenarioOptionConflict,
  DEFAULT_HTTP_PORT,
} from "../server/startServer";
import { DEFAULT_BOOTSTRAP_PACING } from "../server/bootstrapPacing";
import { tlsKeyPermissionWarning } from "../tlsKeyPermissions";
import { cliModuleDir, resolveBundledDist } from "../bundledDist";
import { readPemFile, isLoopbackHost } from "./flagValues";
import { parseTransportFlags } from "./transportFlags";
import { printUsage } from "./usage";
import { createParseState } from "./flags/parseState";
import { parseCpFlag } from "./flags/cpFlags";
import { parseServerFlag } from "./flags/serverFlags";
import { parseSoapSecurityFlag } from "./flags/soapSecurityFlags";
import { parseConnectionFlag } from "./flags/connectionFlags";

export function parseArgs(argv: string[]): CLIOptions {
  const s = createParseState();

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    const cur = { i };

    if (
      !parseCpFlag(s, arg, next, cur) &&
      !parseServerFlag(s, arg, next, cur) &&
      !parseSoapSecurityFlag(s, arg, next, cur) &&
      !parseConnectionFlag(s, arg, next, cur)
    ) {
      if (arg.startsWith("--")) {
        process.stderr.write(`Unknown option: ${arg}\n`);
        printUsage();
        process.exit(1);
      }
    }
    i = cur.i;
  }

  const isClientMode = s.send !== null || s.events || s.stop;

  if (!isClientMode && s.daemon && s.httpPort == null) {
    s.httpPort = DEFAULT_HTTP_PORT;
  }

  let webConsolePort: number | null = null;
  if (s.webConsoleEnabled) {
    if (
      s.webConsoleExplicitPort != null &&
      (isNaN(s.webConsoleExplicitPort) || s.webConsoleExplicitPort < 1)
    ) {
      process.stderr.write(
        "Error: --web-console port must be a positive integer\n",
      );
      process.exit(1);
    }
    // Port resolution: explicit > --http-port > error.
    webConsolePort = s.webConsoleExplicitPort ?? s.httpPort;
    if (webConsolePort == null) {
      process.stderr.write(
        "Error: --web-console without a port requires --http-port " +
          "(the UI shares that listener). Pass a port to --web-console, " +
          "or add --http-port <port>.\n",
      );
      process.exit(1);
    }
    const bundled = resolveBundledDist(s.webConsoleDist);
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
    s.serveStatic = bundled.dir;
    // --web-console alone is enough to put the daemon into server mode —
    // even without --http-port, the web-console port carries socket.io/health
    // alongside the UI on the same origin.
  }

  // A fleet size that is silently wrong is worse than a refused flag: a
  // non-numeric --cp-count would become NaN and bootstrap nothing, and 0 or a
  // negative would quietly bootstrap one, in both cases without saying so.
  if (!Number.isInteger(s.cpCount) || s.cpCount < 1) {
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
    scenario: s.scenario,
    scenarioTemplate: s.scenarioTemplate,
    scenarioTemplateFile: s.scenarioTemplateFile,
    scenarioConnector: s.scenarioConnector,
  });
  if (startupScenarioConflict) {
    process.stderr.write(`Error: ${startupScenarioConflict}\n`);
    process.exit(1);
  }
  if (s.cpCount > 1 && !s.cpId) {
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
  const parsedLabels = labelsSchema.safeParse(
    Object.fromEntries(s.labelEntries),
  );
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
  if (labels && !s.cpId) {
    // Same reasoning as --cp-count: without a cpId nothing is bootstrapped,
    // so the labels would have no charge point to land on.
    process.stderr.write(
      "Error: --label requires --cp-id (it labels the bootstrapped charge points)\n",
    );
    process.exit(1);
  }
  if (
    s.cpCount > 1 &&
    s.cpIdPattern &&
    !hasIdPatternPlaceholder(s.cpIdPattern)
  ) {
    // Without a placeholder every charge point is asked for under the same id,
    // so the second create throws "already exists" and takes the daemon down
    // after a partially-started fleet. Same rule as `cp.create_many`.
    process.stderr.write(
      "Error: --cp-id-pattern must contain {n} or {n:0W}, e.g. CP{n:03}\n",
    );
    process.exit(1);
  }
  if (
    s.cpCount > 1 &&
    s.soapCallbackUrl &&
    !hasIdPatternPlaceholder(s.soapCallbackUrl)
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

  const isServerMode = s.daemon || s.httpPort != null || s.webConsoleEnabled;

  // --soap-tunnel (#183). The ngrok options only mean something with the
  // provider selected; attach mode reads an agent someone else configured,
  // so token and domain cannot apply there. The callback server is the
  // daemon's listener, hence server mode. An explicit callback / public base
  // URL is refused alongside it: the tunnel *is* the public base.
  const ngrokApiUrl = s.ngrok["--ngrok-api-url"];
  const ngrokAuthToken = s.ngrok["--ngrok-auth-token"];
  const ngrokDomain = s.ngrok["--ngrok-domain"];
  let soapTunnelConfig: SoapTunnelConfig | null = null;
  if (s.soapTunnel === "none") {
    const stray = [
      ...Object.entries(s.ngrok),
      ["--soap-tunnel-port", s.soapTunnelPort],
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
    if (ngrokApiUrl && !s.soapTunnelPort) {
      // The daemon can pick any free port for an agent it spawns; an agent
      // someone else runs forwards to the port it was configured with.
      process.stderr.write(
        "Error: --ngrok-api-url requires --soap-tunnel-port <port>, the port the " +
          "running agent forwards to\n",
      );
      process.exit(1);
    }
    if (!isSoapVersion(s.ocppVersion)) {
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
      ["--soap-callback-url", s.soapCallbackUrl],
      ["--soap-public-base-url", s.soapPublicBaseUrl],
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
      localPort: s.soapTunnelPort ?? 0,
    };
  }

  if (s.metrics && s.healthPath === "/metrics") {
    // The health route is matched first, so the enabled Prometheus endpoint
    // would be unreachable while both were advertised as working.
    process.stderr.write(
      "Error: --health-path /metrics collides with the metrics endpoint\n",
    );
    process.exit(1);
  }
  if (s.cpCount > 1 && !isServerMode) {
    // The standalone REPL / JSON paths bootstrap exactly one charge point, so
    // the flag would be accepted and then ignored: `--cp-count 20` would run a
    // single CP and say nothing about the other nineteen.
    process.stderr.write(
      "Error: --cp-count needs a server mode (--daemon, --http-port or --web-console)\n",
    );
    process.exit(1);
  }
  if (s.fleetTemplateFiles.length > 0 && !isServerMode) {
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
    ["--bootstrap-concurrency", s.bootstrapConcurrency, 1, false],
    ["--start-delay", s.startDelay, 0, false],
    ["--start-jitter", s.startJitter, 0, false],
    ["--start-seed", s.startSeed, 0, true],
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
    if (!isServerMode || !s.cpId) {
      process.stderr.write(
        `Error: ${flag} needs a server mode (--daemon, --http-port or --web-console) and --cp-id\n`,
      );
      process.exit(1);
    }
  }
  if (s.startSeed !== undefined && s.startJitter === undefined) {
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
    (Math.max(s.cpCount, 1) - 1) * (pacingValues["--start-delay"] ?? 0) +
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
  if (s.watch && isClientMode) {
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
  if (s.watch && !isServerMode) {
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
    if ((s.send !== null || s.events) && !s.cpId && !s.allEvents) {
      process.stderr.write(
        "Error: --cp-id is required (or --all for --events)\n",
      );
      printUsage();
      process.exit(1);
    }
  } else if (!isServerMode) {
    // REPL / JSON mode requires a single bootstrapped CP
    if (!s.cpId) {
      process.stderr.write("Error: --cp-id is required\n");
      printUsage();
      process.exit(1);
    }
    if (!s.wsUrl) {
      process.stderr.write("Error: --ws-url is required\n");
      printUsage();
      process.exit(1);
    }
  } else {
    // Server mode: cpId is bootstrap-only. If given, ws-url is also required.
    if (s.cpId && !s.wsUrl) {
      process.stderr.write(
        "Error: --ws-url is required when bootstrapping a CP with --cp-id\n",
      );
      printUsage();
      process.exit(1);
    }
  }

  if (isNaN(s.connectors) || s.connectors < 1) {
    process.stderr.write("Error: --connectors must be a positive integer\n");
    process.exit(1);
  }

  if (s.httpPort != null && (isNaN(s.httpPort) || s.httpPort < 1)) {
    process.stderr.write("Error: --http-port must be a positive integer\n");
    process.exit(1);
  }

  // Unix sockets are deprecated for the daemon control plane. The flag is
  // still accepted above for launcher compatibility, but it is always ignored.
  if (isServerMode) {
    s.unixSocket = null;
  }

  const basicAuth =
    s.basicAuthUser && s.basicAuthPass
      ? { username: s.basicAuthUser, password: s.basicAuthPass }
      : null;

  // Both web-console flags must be supplied together. Half-configured auth
  // (e.g. user without pass) would let everyone in or block everyone out,
  // so we hard-fail at startup instead of silently picking one.
  if (
    (s.webConsoleBasicAuthUser === "") !==
    (s.webConsoleBasicAuthPass === "")
  ) {
    process.stderr.write(
      "Error: --web-console-basic-auth-user and --web-console-basic-auth-pass " +
        "must be supplied together (or both omitted)\n",
    );
    process.exit(1);
  }
  const webConsoleBasicAuth =
    s.webConsoleBasicAuthUser && s.webConsoleBasicAuthPass
      ? {
          username: s.webConsoleBasicAuthUser,
          password: s.webConsoleBasicAuthPass,
        }
      : null;

  const behaviorProblem = behaviorFlagProblem({
    serverMode: isServerMode,
    behaviorFiles: s.behaviorFiles,
    allowBehaviorCode: s.allowBehaviorCode,
    unsafeRemote: s.unsafeRemote,
    useBehaviors: s.useBehaviors,
    watchBehaviors: s.watchBehaviors,
    allowBehaviorReload: s.allowBehaviorReload,
  });
  if (behaviorProblem) {
    process.stderr.write(`${behaviorProblem}\n`);
    process.exit(1);
  }
  if (
    isClientMode &&
    (s.behaviorFiles.length > 0 ||
      s.allowBehaviorCode ||
      s.useBehaviors.length > 0 ||
      s.watchBehaviors ||
      s.allowBehaviorReload)
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
    behaviorParams = collectBehaviorParams(s.behaviorParamSpecs);
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
  if (isClientMode && s.behaviorParamSpecs.length > 0) {
    process.stderr.write(
      "Error: --behavior-params applies to a running charge point, not to --send / --stop / --events\n",
    );
    process.exit(1);
  }
  if (s.behaviorParamSpecs.length > 0 && !s.cpId) {
    process.stderr.write(
      "Error: --behavior-params requires --cp-id (it sets the params of the bootstrapped charge points)\n",
    );
    process.exit(1);
  }
  if (s.useBehaviors.length > 0 && !s.cpId) {
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
    !isLoopbackHost(s.httpHost) &&
    !webConsoleBasicAuth &&
    !s.unsafeRemote
  ) {
    process.stderr.write(
      `Error: refusing to bind unauthenticated daemon to non-loopback host ` +
        `${s.httpHost}. Configure --web-console-basic-auth-user and ` +
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
    s.requireTls &&
    !isLoopbackHost(s.httpHost) &&
    s.trustedProxies.length === 0
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
    s.requireTls &&
    isLoopbackHost(s.httpHost) &&
    s.trustedProxies.length === 0
  ) {
    process.stderr.write(
      "Warning: --require-tls without --trusted-proxy only constrains " +
        "clients that connect from another host. Behind a reverse proxy on " +
        "this host, add --trusted-proxy 127.0.0.1 so the proxy has to report " +
        "https.\n",
    );
  }

  // Same all-or-nothing rule for the client-side credentials.
  if ((s.httpBasicAuthUser === "") !== (s.httpBasicAuthPass === "")) {
    process.stderr.write(
      "Error: --http-basic-auth-user and --http-basic-auth-pass " +
        "must be supplied together (or both omitted)\n",
    );
    process.exit(1);
  }
  const httpBasicAuth =
    s.httpBasicAuthUser && s.httpBasicAuthPass
      ? { username: s.httpBasicAuthUser, password: s.httpBasicAuthPass }
      : null;
  let tls: CLIOptions["tls"];
  if (s.tlsCaPath || s.tlsCertPath || s.tlsKeyPath) {
    tls = {};
    if (s.tlsCaPath) tls = { ...tls, ca: readPemFile("--tls-ca", s.tlsCaPath) };
    if (s.tlsCertPath) {
      tls = { ...tls, cert: readPemFile("--tls-cert", s.tlsCertPath) };
    }
    if (s.tlsKeyPath) {
      const warning = tlsKeyPermissionWarning(s.tlsKeyPath);
      if (warning && !s.insecureTlsKeyPerms) {
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
      tls = { ...tls, key: readPemFile("--tls-key", s.tlsKeyPath) };
    }
  }

  // Resolve the SOAP callback URL by precedence: an explicit --soap-callback-url
  // wins; otherwise --soap-public-base-url derives it. With --soap-tunnel the
  // public base is only known once the tunnel is up, so main() resolves it
  // then — see soapCallbackUrl.ts for the ladder.
  const resolvedSoapCallbackUrl = resolveSoapCallbackUrl({
    explicitCallbackUrl: s.soapCallbackUrl,
    publicBaseUrl: s.soapPublicBaseUrl,
    cpId: s.cpId,
    soapPath: s.soapPath,
  });
  if (!s.soapCallbackUrl && s.soapPublicBaseUrl && resolvedSoapCallbackUrl) {
    process.stderr.write(
      `SOAP callback URL resolved from --soap-public-base-url: ${resolvedSoapCallbackUrl}\n`,
    );
  }
  if (isSoapVersion(s.ocppVersion) && resolvedSoapCallbackUrl) {
    const suffixWarning = soapCallbackUrlSuffixWarning(resolvedSoapCallbackUrl);
    if (suffixWarning) {
      process.stderr.write(`Warning: ${suffixWarning}\n`);
    }
  }

  return {
    wsUrl: s.wsUrl,
    cpId: s.cpId,
    cpCount: s.cpCount,
    cpIdPattern: s.cpIdPattern,
    fleetTemplateFiles: s.fleetTemplateFiles,
    bootstrapPacing,
    labels,
    metrics: s.metrics,
    metricsNoAuth: s.metricsNoAuth,
    watch: s.watch,
    connectors: s.connectors,
    jsonMode: s.jsonMode,
    daemon: s.daemon,
    send: s.send,
    events: s.events,
    stop: s.stop,
    basicAuth,
    webConsoleBasicAuth,
    vendor: s.vendor,
    model: s.model,
    ocppVersion: s.ocppVersion,
    scenario: s.scenario,
    scenarioTemplate: s.scenarioTemplate,
    scenarioTemplateFile: s.scenarioTemplateFile,
    scenarioConnector: s.scenarioConnector,
    httpPort: s.httpPort,
    httpHost: s.httpHost,
    unixSocket: s.unixSocket,
    httpUrl: s.httpUrl,
    httpBasicAuth,
    allEvents: s.allEvents,
    unsafeRemote: s.unsafeRemote,
    behaviorFiles: s.behaviorFiles,
    allowBehaviorCode: s.allowBehaviorCode,
    useBehaviors: s.useBehaviors,
    behaviorParams,
    watchBehaviors: s.watchBehaviors,
    allowBehaviorReload: s.allowBehaviorReload,
    corsOrigins: s.corsOrigins,
    trustForwardedHeaders: s.trustForwardedHeaders,
    allowedHosts: s.allowedHosts,
    trustedProxies: s.trustedProxies,
    requireTls: s.requireTls,
    rateLimitPerIp: s.rateLimitPerIp,
    rateLimitMaxIps: s.rateLimitMaxIps,
    logLevel: s.logLevel,
    logFile: s.logFile,
    logMaxBytes: s.logMaxBytes,
    logRotateDaily: s.logRotateDaily,
    logKeep: s.logKeep,
    shutdownStopTransactions: s.shutdownStopTransactions,
    shutdownWaitMs: s.shutdownWaitMs,
    connectRestored: s.connectRestored,
    cpBulkWaitMs: s.cpBulkWaitMs,
    serveStatic: s.serveStatic,
    webConsolePort,
    stateDb: s.stateDb,
    logFormat: s.logFormat,
    healthPath: s.healthPath,
    extraWsHeaders: s.extraWsHeaders,
    extraWsSubprotocols: s.extraWsSubprotocols,
    soapCallbackUrl: resolvedSoapCallbackUrl,
    soapCallbackUrlExplicit: s.soapCallbackUrl,
    soapPublicBaseUrl: s.soapPublicBaseUrl,
    oedBaseUrl: s.oedBaseUrl,
    oedApiKeyFile: s.oedApiKeyFile,
    soapTunnel: soapTunnelConfig,
    soapPath: s.soapPath,
    securityProfile: s.securityProfile,
    authorizationKey: s.authorizationKey,
    cpoName: s.cpoName,
    ...(s.txUpdatedMeterValues !== undefined
      ? { txUpdatedMeterValues: s.txUpdatedMeterValues }
      : {}),
    ...(s.inboundValidation ? { inboundValidation: s.inboundValidation } : {}),
    ...(s.reservationAuthorizeIdTag
      ? { reservationAuthorizeIdTag: s.reservationAuthorizeIdTag }
      : {}),
    ...(Object.keys(s.reconnect).length > 0 || Object.keys(s.wsFlags).length > 0
      ? {
          transport: parseTransportFlags(s.reconnect, s.wsFlags, s.ocppVersion),
        }
      : {}),
    tls,
    tlsCaPath: s.tlsCaPath,
    tlsCertPath: s.tlsCertPath,
    tlsKeyPath: s.tlsKeyPath,
    insecureTlsKeyPerms: s.insecureTlsKeyPerms,
    traceOutput: s.traceOutput,
  };
}
