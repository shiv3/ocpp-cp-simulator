import * as fs from "fs";
import type { CLIOptions, ChargePointInitOptions } from "../types";
import {
  resolveVehicleCatalogConfig,
  type VehicleCatalogConfig,
} from "../vehicleCatalogConfig";
import { isLoopbackHost } from "./flagValues";

/**
 * #458: the daemon's Open EV Directory settings, from the flags and the
 * environment. A broken setting (an unreadable key file, a malformed
 * OED_BASE_URL) stops the daemon rather than starting with import silently
 * disabled; a key without a URL only warns.
 */
export function vehicleCatalogConfigOrExit(
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
export function resolveCorsPolicy(rawOptions: CLIOptions):
  | { kind: "any" }
  | { kind: "allowlist"; origins: string[] }
  | {
      kind: "same-origin";
      trustForwardedHeaders: boolean;
      allowedHosts?: string[];
    } {
  // A listed `--trusted-proxy` is a stricter form of trusting the headers.
  const options = {
    ...rawOptions,
    trustForwardedHeaders:
      rawOptions.trustForwardedHeaders || rawOptions.trustedProxies.length > 0,
  };
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
    ...(options.txUpdatedMeterValues !== undefined
      ? { txUpdatedMeterValues: options.txUpdatedMeterValues }
      : {}),
    ...(options.inboundValidation
      ? { inboundValidation: options.inboundValidation }
      : {}),
    ...(options.reservationAuthorizeIdTag
      ? { reservationAuthorizeIdTag: true }
      : {}),
    ...(options.transport ? { transport: options.transport } : {}),
    ...((options.useBehaviors?.length ?? 0) > 0
      ? { behaviors: [...options.useBehaviors!] }
      : {}),
    ...(Object.keys(options.behaviorParams ?? {}).length > 0
      ? { behaviorParams: { ...options.behaviorParams } }
      : {}),
    tls: options.tls,
    tlsCaPath: options.tlsCaPath,
    tlsCertPath: options.tlsCertPath,
    tlsKeyPath: options.tlsKeyPath,
    labels: options.labels,
  };
}
