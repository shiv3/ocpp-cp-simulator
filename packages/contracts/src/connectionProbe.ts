import { z } from "zod";
import { ARRAY_1000, STR_256, STR_64K } from "./limits";

/**
 * One-shot connection check (#1132): would a station with these settings get
 * in? The vocabulary of the verdict `cp.probe` returns, shared by the daemon,
 * the MCP tool and `ocpp-cp-sim cp probe`.
 */

/**
 * How far the attempt got. `config` is a refusal before anything was dialled;
 * `handshake` is reported when the client cannot tell which step stalled (a
 * timeout, an unclassified failure); `open` is a WebSocket that opened with an
 * agreed subprotocol.
 */
export const CONNECTION_PROBE_STAGES = [
  "config",
  "dns",
  "tcp",
  "tls",
  "upgrade",
  "subprotocol",
  "handshake",
  "open",
] as const;
export type ConnectionProbeStage = (typeof CONNECTION_PROBE_STAGES)[number];

/** Stable, machine-readable outcome codes. `ok` is the only success. */
export const CONNECTION_PROBE_CODES = [
  "ok",
  "invalid_url",
  "invalid_security_profile",
  "dns_failure",
  "connection_refused",
  "host_unreachable",
  "timeout",
  "tls_untrusted_certificate",
  "tls_failed",
  "credentials_refused",
  "path_not_found",
  "csms_busy",
  "redirected",
  "upgrade_refused",
  "not_websocket",
  "subprotocol_not_agreed",
  "connection_failed",
] as const;
export type ConnectionProbeCode = (typeof CONNECTION_PROBE_CODES)[number];

/** Default handshake budget of a probe, in milliseconds. */
export const CONNECTION_PROBE_DEFAULT_TIMEOUT_MS = 8_000;
/** Largest accepted budget: the probe has to answer inside the RPC deadline. */
export const CONNECTION_PROBE_MAX_TIMEOUT_MS = 15_000;

export const connectionProbeResultSchema = z.object({
  ok: z.boolean(),
  code: z.enum(CONNECTION_PROBE_CODES),
  stage: z.enum(CONNECTION_PROBE_STAGES),
  /** The URL dialled, id and suffix included; a password in it is redacted. */
  url: STR_64K,
  message: STR_64K,
  hint: STR_64K.optional(),
  /** The status a refused upgrade was answered with. */
  httpStatus: z.number().int().optional(),
  /** A redirect's target, redacted like the URL. */
  location: STR_64K.optional(),
  /** The `Sec-WebSocket-Protocol` values offered. */
  offeredSubprotocols: z.array(STR_256).max(64),
  /** The subprotocol the server agreed to, once the socket opened. */
  subprotocol: STR_256.optional(),
  durationMs: z.number().min(0),
  /** Configuration warnings (scheme upgrades, a doubled id, …). */
  warnings: ARRAY_1000(STR_64K),
});
export type ConnectionProbeResult = z.infer<typeof connectionProbeResultSchema>;
