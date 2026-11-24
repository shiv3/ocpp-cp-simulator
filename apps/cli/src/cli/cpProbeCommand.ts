import type {
  ConnectionProbeResult,
  Params,
} from "@ocpp-cp-simulator/contracts/index";
import {
  isOcppVersion,
  isSoapVersion,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import { probeConnection } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/ws/connectionProbe";
import { ocppVersionToSubprotocol } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/wsUrlWithBasic";
import { probeViaDaemon } from "../client";
import { lookupHost } from "../server/rpc/cpProbe";
import type { CLIOptions } from "../types";
import { parseArgs } from "./parseArgs";

/**
 * `ocpp-cp-sim cp probe` (#1132): one handshake with the flags a local charge
 * point takes (`--cp-id`, `--ws-url`, `--ocpp-version`, `--basic-auth-*`,
 * `--security-profile`, `--authorization-key`, `--tls-*`, `--ws-*`, `--header`,
 * `--ws-subprotocol`), then closed; no OCPP message is sent. With
 * `--http-url` the daemon there runs it (`cp.probe`), from its own network.
 *
 * Exit status: 0 when the verdict is ok, 1 otherwise (including a probe that
 * could not run). `--json` prints the verdict object on one line.
 */
export async function runCpProbeCommand(argv: string[]): Promise<number> {
  const options = parseArgs(["bun", "ocpp-cp-sim", ...argv]);
  if (
    options.daemon ||
    options.httpPort != null ||
    options.webConsolePort != null ||
    options.send !== null ||
    options.events ||
    options.stop
  ) {
    process.stderr.write(
      "Error: cp probe takes the connection flags of a charge point, not a server or client mode\n",
    );
    return 1;
  }
  // parseArgs has refused a missing --cp-id / --ws-url already.
  const cpId = options.cpId ?? "";
  const ocppVersion = options.ocppVersion ?? "OCPP-1.6J";
  if (!isOcppVersion(ocppVersion) || isSoapVersion(ocppVersion)) {
    process.stderr.write(
      "Error: cp probe checks the OCPP-J WebSocket handshake; the SOAP versions have none\n",
    );
    return 1;
  }
  let result: ConnectionProbeResult;
  try {
    result = argv.includes("--http-url")
      ? await probeViaDaemon(
          {
            httpUrl: options.httpUrl ?? "",
            basicAuth: options.httpBasicAuth,
          },
          daemonParams(options, cpId, ocppVersion),
        )
      : await probeConnection(
          {
            baseUrl: options.wsUrl,
            chargePointId: cpId,
            ocppVersion,
            basicAuth: options.basicAuth,
            securityProfile: options.securityProfile,
            authorizationKey: options.authorizationKey,
            ...(options.tls ? { tls: options.tls } : {}),
            ...(options.transport?.ws ? { ws: options.transport.ws } : {}),
            extraHeaders: options.extraWsHeaders,
            extraSubprotocols: options.extraWsSubprotocols,
          },
          { lookup: lookupHost },
        );
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  process.stdout.write(
    options.jsonMode ? `${JSON.stringify(result)}\n` : formatVerdict(result),
  );
  return result.ok ? 0 : 1;
}

/** The `cp.probe` params for a daemon: TLS goes as paths, read there. */
function daemonParams(
  options: CLIOptions,
  cpId: string,
  ocppVersion: string,
): Params<"cp.probe"> {
  return {
    cpId,
    wsUrl: options.wsUrl,
    ocppVersion,
    ...(options.basicAuth ? { basicAuth: options.basicAuth } : {}),
    ...(options.securityProfile !== undefined
      ? { securityProfile: options.securityProfile }
      : {}),
    ...(options.authorizationKey
      ? { authorizationKey: options.authorizationKey }
      : {}),
    ...(options.tlsCaPath ? { tlsCaPath: options.tlsCaPath } : {}),
    ...(options.tlsCertPath ? { tlsCertPath: options.tlsCertPath } : {}),
    ...(options.tlsKeyPath ? { tlsKeyPath: options.tlsKeyPath } : {}),
    ...(options.transport?.ws ||
    Object.keys(options.extraWsHeaders).length > 0 ||
    options.extraWsSubprotocols.length > 0
      ? { transport: { ws: daemonWsOptions(options, ocppVersion) } }
      : {}),
  } as Params<"cp.probe">;
}

type ProbeWsOptions = NonNullable<
  NonNullable<Params<"cp.probe">["transport"]>["ws"]
>;

/** `--header` and `--ws-subprotocol` ride in `transport.ws`, the only place
 *  `cp.probe` takes them: headers merged, the extra subprotocols after the
 *  version's own (what the station would offer). */
function daemonWsOptions(
  options: CLIOptions,
  ocppVersion: string,
): ProbeWsOptions {
  const ws: ProbeWsOptions = { ...(options.transport?.ws ?? {}) };
  const headers = { ...options.extraWsHeaders, ...(ws.headers ?? {}) };
  if (Object.keys(headers).length > 0) ws.headers = headers;
  if (!ws.subprotocols && options.extraWsSubprotocols.length > 0) {
    ws.subprotocols = [
      ocppVersionToSubprotocol(ocppVersion),
      ...options.extraWsSubprotocols,
    ];
  }
  return ws;
}

export function formatVerdict(result: ConnectionProbeResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push(
      `ok: ${result.url}${result.subprotocol ? ` (subprotocol ${result.subprotocol})` : ""}, ${Math.round(result.durationMs)} ms`,
    );
  } else {
    lines.push(
      `failed: ${result.code} at ${result.stage}${result.httpStatus !== undefined ? ` (HTTP ${result.httpStatus})` : ""}`,
      `  url:     ${result.url}`,
      `  message: ${result.message}`,
    );
    if (result.hint) lines.push(`  hint:    ${result.hint}`);
    if (result.location) lines.push(`  location: ${result.location}`);
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}
