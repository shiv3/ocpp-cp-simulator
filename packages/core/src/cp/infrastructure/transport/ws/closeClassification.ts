import type { CloseCause, GenerationToken } from "../network-sim";
import type { SocketClose } from "../../../domain/transport/ChargePointSocket";
import { redactSensitiveText } from "../../../shared/redaction";

/**
 * Whether a connection attempt ended before any peer answered: connection
 * refused or unreachable, or a DNS failure. Such an attempt presented no
 * certificate, so it says nothing about it (#537, A02.FR.28). Bun's close
 * reason says so; the `ws` path reports the same one. Measured on Bun 1.3.14
 * and 1.4.3, a CSMS refusing a client certificate closes with `Connection
 * ended` (1006), a refused upgrade with `Expected 101 status code` (1002)
 * and a handshake dropped early with `TLS handshake failed` (1015): none
 * match, so all of them count as the certificate failing. A refused upgrade
 * counts because Bun hides its status, and a proxy that terminates TLS can
 * refuse a client certificate with one.
 */
export function neverReachedCsms(close: SocketClose): boolean {
  return close.code === 1006 && /^Failed to connect/i.test(close.reason);
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
