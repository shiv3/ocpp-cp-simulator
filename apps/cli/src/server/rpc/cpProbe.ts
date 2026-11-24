import * as fs from "fs";
import { promises as dns } from "node:dns";
import {
  CONNECTION_PROBE_DEFAULT_TIMEOUT_MS,
  CONNECTION_PROBE_MAX_TIMEOUT_MS,
  RpcFailure,
  type ConnectionProbeResult,
  type Params,
} from "@ocpp-cp-simulator/contracts/index";
import {
  isOcppVersion,
  isSoapVersion,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import {
  probeConnection,
  type ConnectionProbeInput,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/ws/connectionProbe";
import { assertWsClientOptions } from "@ocpp-cp-simulator/core/cp/shared/WsClientOptions";
import type { OcppTlsOptions } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/wsUrlWithBasic";
import { tlsKeyPermissionWarning } from "../../tlsKeyPermissions";
import { mergeTlsOptions } from "../registry/rowMapping";
import type { RuntimeSocketIoDeps } from "../socketServer";

/**
 * `cp.probe` (#1132): one handshake with the settings `cp.create` would give
 * the station, then closed. Nothing is created, persisted or sent over OCPP.
 * A refused connection is the verdict, not an error; only parameters that
 * cannot describe a WebSocket station answer `invalid_params`.
 */
export async function probeCp(
  deps: RuntimeSocketIoDeps,
  params: Params<"cp.probe">,
): Promise<ConnectionProbeResult> {
  return probeConnection(
    probeInputFromParams(params, {
      allowInsecureTlsKeyPerms: deps.registry.options.allowInsecureTlsKeyPerms,
    }),
    { lookup: lookupHost },
  );
}

/** Tells an unknown host from a closed port when Bun says neither (#1132). */
export async function lookupHost(hostname: string): Promise<void> {
  await dns.lookup(hostname);
}

/** The connection fields of a `cp.create` body, read as the registry reads
 *  them on create (TLS files included). Throws `invalid_params`. */
export function probeInputFromParams(
  params: Params<"cp.probe">,
  opts: { readonly allowInsecureTlsKeyPerms?: boolean } = {},
): ConnectionProbeInput {
  const version = params.ocppVersion ?? "OCPP-1.6J";
  if (!isOcppVersion(version)) {
    throw new RpcFailure(
      "invalid_params",
      "ocppVersion must be a supported OCPP version",
    );
  }
  if (isSoapVersion(version)) {
    throw new RpcFailure(
      "invalid_params",
      "cp.probe checks the OCPP-J WebSocket handshake; the SOAP versions have none",
    );
  }
  const urls = Array.isArray(params.wsUrl) ? params.wsUrl : [params.wsUrl];
  const warnings =
    urls.length > 1
      ? [
          `Probing the first of ${urls.length} supervision URLs only; probe the others one at a time`,
        ]
      : [];
  const ws = params.transport?.ws;
  try {
    assertWsClientOptions(ws);
  } catch (err) {
    throw new RpcFailure(
      "invalid_params",
      err instanceof Error ? err.message : String(err),
    );
  }
  const tls = readTls(params, opts);
  return {
    baseUrl: urls[0],
    chargePointId: params.cpId,
    ocppVersion: version,
    basicAuth: params.basicAuth ?? null,
    ...(params.securityProfile !== undefined
      ? { securityProfile: params.securityProfile }
      : {}),
    ...(params.authorizationKey !== undefined
      ? { authorizationKey: params.authorizationKey }
      : {}),
    ...(tls ? { tls } : {}),
    ...(ws ? { ws } : {}),
    // The handshake timeout of `transport.ws` stands in for `timeoutMs`, capped
    // like it so the verdict arrives inside the RPC deadline.
    timeoutMs: Math.min(
      params.timeoutMs ??
        ws?.handshakeTimeoutMs ??
        CONNECTION_PROBE_DEFAULT_TIMEOUT_MS,
      CONNECTION_PROBE_MAX_TIMEOUT_MS,
    ),
    warnings,
  };
}

/** A file wins over inline material for the same field, as on create
 *  (`prepareInit`). */
function readTls(
  params: Params<"cp.probe">,
  opts: { readonly allowInsecureTlsKeyPerms?: boolean },
): OcppTlsOptions | undefined {
  const fromFiles: { ca?: string; cert?: string; key?: string } = {};
  if (params.tlsCaPath) fromFiles.ca = readPem("tlsCaPath", params.tlsCaPath);
  if (params.tlsCertPath) {
    fromFiles.cert = readPem("tlsCertPath", params.tlsCertPath);
  }
  if (params.tlsKeyPath) {
    const warning = tlsKeyPermissionWarning(params.tlsKeyPath);
    if (warning && !opts.allowInsecureTlsKeyPerms) {
      throw new RpcFailure("invalid_params", warning);
    }
    fromFiles.key = readPem("tlsKeyPath", params.tlsKeyPath);
  }
  const tls = mergeTlsOptions(params.tls, fromFiles);
  return Object.keys(tls).length > 0 ? tls : undefined;
}

function readPem(field: string, filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    throw new RpcFailure("invalid_params", `${field}: cannot read the file`);
  }
}
