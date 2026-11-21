#!/usr/bin/env bun
import { startRepl } from "./repl";
import { startJsonMode } from "./jsonMode";
import { routeLogsToStderr } from "./jsonLines";
import { resolveClientLocation } from "./clientLocation";
import { openSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/openSqliteDatabase";
import { isMainModule } from "./runtime";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import { setGlobalLogFormat } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import { setGlobalTraceWriter } from "./trace/globalTraceWriter";
import { loadTraceFeature } from "./trace/loadTraceFeature";
import { setProcessTimeScale } from "./timeScale";
import { parseAnalyzeArgs } from "./analyze/parseAnalyzeArgs";
import { buildBehaviorFile, parseBehaviorArgs } from "./behavior/buildBehavior";
import { parseExportK6Args } from "./exportK6/parseExportK6Args";
import { runExportK6 } from "./exportK6/runExportK6";
import { initErrorReporting, reportFatalError } from "./errorReporting";
import {
  startServer,
  DEFAULT_HTTP_PORT,
  DEFAULT_PID_PATH,
} from "./server/startServer";
import { sendCommand, subscribeEvents, stopDaemon } from "./client";
import { installLogSink } from "./logSink";
import type { ClientLocation } from "./client";
import { loadFleetTemplateFiles } from "./server/fleetTemplateFiles";
import type { FleetTemplate } from "@ocpp-cp-simulator/contracts/index";
import { parseArgs } from "./cli/parseArgs";
import {
  vehicleCatalogConfigOrExit,
  resolveCorsPolicy,
  buildBootstrap,
} from "./cli/serverOptions";
import {
  loadBehavesOrExit,
  createStandaloneChargePointRuntime,
} from "./cli/standaloneRuntime";

export { resolveBundledDist, type BundledDistLookup } from "./bundledDist";
export { parseArgs } from "./cli/parseArgs";
export { buildBootstrap } from "./cli/serverOptions";

async function main(): Promise<void> {
  // Opt-in (#794): a no-op without OCPP_SIM_ERROR_REPORTER. First, so every
  // mode reports.
  await initErrorReporting();

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
    const { runAnalyze } = await loadTraceFeature(
      "analyze",
      () => import("./analyze/runAnalyze"),
    );
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
  // --json --log-to-stderr: stdout carries only JSON Lines (#1088).
  if (options.jsonMode && options.logToStderr) routeLogsToStderr();
  // --log-level / --log-file (#621). Wraps the console only when asked for.
  try {
    installLogSink({
      level: options.logLevel ?? undefined,
      file: options.logFile
        ? {
            file: options.logFile,
            maxBytes: options.logMaxBytes ?? undefined,
            daily: options.logRotateDaily,
            keep: options.logKeep,
          }
        : undefined,
    });
  } catch (err) {
    process.stderr.write(
      `Error: cannot write log file: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // --time-scale: set before any charge point is built; each one reads the
  // process clock in its constructor.
  if (options.timeScale !== undefined) setProcessTimeScale(options.timeScale);

  // --trace-output (#188): construct the global TraceWriter before any CP is
  // built (CLIChargePointService.attach()es to it in its constructor, so
  // every mode's CP -- standalone, daemon create/restore/update -- picks it
  // up uniformly). A bad path (missing parent dir, no permission) must fail
  // loudly at startup rather than silently losing every trace record.
  if (options.traceOutput) {
    try {
      const { TraceWriter } = await loadTraceFeature(
        "--trace-output",
        () => import("./trace/TraceWriter"),
      );
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
    let fleetTemplates: FleetTemplate[] = [];
    try {
      fleetTemplates = loadFleetTemplateFiles(options.fleetTemplateFiles);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    await startServer({
      fleetTemplates,
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
      access: {
        allowedHosts: options.allowedHosts,
        trustedProxies: options.trustedProxies,
        requireTls: options.requireTls,
        rateLimitPerIp: options.rateLimitPerIp,
        rateLimitMaxIps: options.rateLimitMaxIps,
      },
      shutdownStopTransactions: options.shutdownStopTransactions
        ? { waitMs: options.shutdownWaitMs }
        : undefined,
      shutdownWaitMs: options.shutdownWaitMs,
      connectRestored: options.connectRestored,
      cpBulkWaitMs: options.cpBulkWaitMs,
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
    replDatabase = await openSqliteDatabase(options.stateDb);
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

if (isMainModule(import.meta)) {
  main().catch(async (err) => {
    process.stderr.write(
      `Fatal: ${err instanceof Error ? err.message : err}\n`,
    );
    await reportFatalError(err);
    process.exit(1);
  });
}
