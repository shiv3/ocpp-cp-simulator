import type { CloseCause, GenerationToken } from "../network-sim";
import type { SocketClose } from "../../../domain/transport/ChargePointSocket";
import { redactSensitiveText } from "../../../shared/redaction";

/** What a failed connection attempt's error event says, read defensively. */
export interface ConnectErrorDetail {
  readonly message?: string;
  /** Bun 1.4.4+ and the `ws` path: `ECONNREFUSED`, `EPROTO`, … */
  readonly code?: string;
  /** The `ws` path only: the Node call that failed (`connect`, …). */
  readonly syscall?: string;
  /** The `ws` path only: the status of a refused upgrade (#288). */
  readonly httpStatus?: number;
  readonly httpLocation?: string;
}

/**
 * - `unreached`: no peer answered (refused, unreachable, DNS failure);
 * - `upgrade-refused`: an HTTP server answered the upgrade with no 101;
 * - `tls`: the TLS handshake failed;
 * - `other`: anything else, an attempt with no detail at all included.
 */
export type FailedAttemptKind =
  "unreached" | "upgrade-refused" | "tls" | "other";

function stringField(source: unknown, key: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** Reads an `error` event without trusting its shape: Bun's ErrorEvent, the
 *  `ws` path's object carrying the raw Node error, or a bare Event. */
export function describeConnectError(ev: Event): ConnectErrorDetail {
  const error = (ev as { error?: unknown }).error;
  const status = (ev as { httpStatus?: unknown }).httpStatus;
  const message = stringField(ev, "message");
  const code = stringField(error, "code");
  const syscall = stringField(error, "syscall");
  const location = stringField(ev, "httpLocation");
  return {
    ...(message !== undefined ? { message } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(syscall !== undefined ? { syscall } : {}),
    ...(typeof status === "number" ? { httpStatus: status } : {}),
    ...(location !== undefined ? { httpLocation: location } : {}),
  };
}

/** No peer answered: the Bun 1.4.4 codes measured by
 *  repro/bun-1.4.x/ws-failure-causes.ts, and their DNS and routing kin. */
const UNREACHED_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);
/** The `ws` path's rule for the same thing (see wsUrlWithBasic.ts). */
const UNREACHED_SYSCALLS = new Set(["connect", "getaddrinfo"]);
const REFUSED_UPGRADE = /expected 101 status code/i;
const TLS_CODE = /^EPROTO$|CERT|^ERR_TLS_|^ERR_SSL_|^UNABLE_TO_/;

/**
 * What a failed connection attempt was, from its first error event and its
 * close (#1033, #1034).
 *
 * Bun 1.3.14 and 1.4.3 give no error code and say it in the close: a refused
 * connection or a DNS failure closes with `Failed to connect` (1006), a
 * refused upgrade with `Expected 101 status code` (1002), a TLS handshake
 * failure with `TLS handshake failed` (1015) and a CSMS refusing the client
 * certificate with `Connection ended` (1006). Bun 1.4.4 closes every failed
 * attempt with a blank 1006 and puts the cause on the error event before it:
 * `error.code` ECONNREFUSED or ENOTFOUND for an unreached server, ECONNRESET
 * for a refused client certificate, EPROTO or a certificate code such as
 * DEPTH_ZERO_SELF_SIGNED_CERT for TLS, and no code at all for a refused
 * upgrade, whose message alone reads `Expected 101 status code: 401`. The
 * `ws` path dispatches the raw Node error (`code`, `syscall`) and the status
 * of a refused upgrade (`httpStatus`).
 *
 * ECONNRESET is never `unreached`: a peer answered. A blank 1006 alone is
 * never `upgrade-refused`.
 */
export function classifyFailedAttempt(
  close: SocketClose,
  error?: ConnectErrorDetail,
): FailedAttemptKind {
  const code = error?.code;
  if (code === "ECONNRESET") return "other";
  if (typeof error?.httpStatus === "number") return "upgrade-refused";
  if (code !== undefined && UNREACHED_CODES.has(code)) return "unreached";
  if (error?.syscall !== undefined && UNREACHED_SYSCALLS.has(error.syscall)) {
    return "unreached";
  }
  if (REFUSED_UPGRADE.test(error?.message ?? "")) return "upgrade-refused";
  if (code !== undefined && TLS_CODE.test(code)) return "tls";
  // Bun 1.4.3 and earlier: the close says it.
  if (close.code === 1006 && /^Failed to connect/i.test(close.reason)) {
    return "unreached";
  }
  if (close.code === 1002 && REFUSED_UPGRADE.test(close.reason)) {
    return "upgrade-refused";
  }
  return close.code === 1015 ? "tls" : "other";
}

/**
 * Whether a connection attempt ended before any peer answered. Such an
 * attempt presented no certificate, so it says nothing about it (#537,
 * A02.FR.28). Every other failure counts as the certificate failing, a TLS
 * failure and a refused upgrade included: a proxy that terminates TLS can
 * refuse a client certificate with an HTTP status.
 */
export function neverReachedCsms(
  close: SocketClose,
  error?: ConnectErrorDetail,
): boolean {
  return classifyFailedAttempt(close, error) === "unreached";
}

/**
 * Reported for a socket the charge point closed itself (reset, disconnect)
 * when the next connect supersedes it before its close event lands (#478).
 * `close()` sends no status code, so the late close event mostly reads 1005
 * as well.
 */
export const SUPERSEDED_CLOSE: SocketClose = { code: 1005, reason: "" };

/**
 * GenerationTokenImpl: immutable per-generation object carrying the generation number
 * and, once closed, its latched close cause. First-cause latching: the first close
 * of a generation latches its cause; later close processing for that same generation
 * must NOT overwrite it.
 */
export class GenerationTokenImpl implements GenerationToken {
  private _closeCause: CloseCause | null = null;
  /** The charge point has been told this generation's socket closed (#478). */
  closeReported = false;

  constructor(readonly gen: number) {}

  get closeCause(): CloseCause | null {
    return this._closeCause;
  }

  latchCloseCause(cause: CloseCause): void {
    if (this._closeCause === null) {
      this._closeCause = cause;
    }
  }
}

/** One sentence per HTTP status, naming the operator's next move (#288). */
export function describeRefusal(status: number, location?: string): string {
  const hint =
    status === 401 || status === 403
      ? " — credentials refused, or the CSMS considers the connection insecure for its security profile"
      : status === 404
        ? " — the CSMS does not know this charge point id"
        : status >= 300 && status < 400
          ? // The Location comes from the CSMS and may carry userinfo or a
            // secret query parameter of its own, so it is redacted like any
            // other URL that reaches the log.
            ` — the endpoint redirects${location ? ` to ${redactSensitiveText(location)}` : ""}; a cleartext ws:// to a TLS-only edge looks like this`
          : "";
  return `WebSocket upgrade refused: HTTP ${status}${hint}`;
}
