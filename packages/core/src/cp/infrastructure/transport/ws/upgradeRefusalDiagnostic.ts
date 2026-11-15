import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import { redactSensitiveText } from "../../../shared/redaction";
import {
  probeUpgradeRefusal,
  type OcppWebSocketConnectOptions,
} from "../wsUrlWithBasic";
import { describeRefusal } from "./closeClassification";

/** At most one diagnostic GET per charge point in this window. */
const PROBE_INTERVAL_MS = 60_000;

/**
 * #288 — say why a connection attempt failed, not merely that it did.
 *
 * Owns the error log of a connection attempt and the diagnostic GET that
 * replays a refused handshake to learn its HTTP status, with the budget that
 * keeps the reconnect loop from multiplying the CSMS's request rate.
 */
export class UpgradeRefusalDiagnostic {
  /** When the probe last ran. Cleared on a successful open. */
  private lastProbeAt = 0;

  /**
   * @param stillFailing whether the probe's answer still describes the
   *   connection that asked: the transport is not disposed, `generation` is
   *   still the current one and its socket is not open.
   */
  constructor(
    private readonly logger: Logger,
    private readonly stillFailing: (generation: number) => boolean,
  ) {}

  /** A working connection clears the budget, so the next genuine refusal is
   *  diagnosed immediately rather than waiting out the window. */
  clearBudget(): void {
    this.lastProbeAt = 0;
  }

  /**
   * Logs an attempt's error event; returns whether it carried the HTTP status.
   *
   * The event carries a message on every runtime that has one to give: the
   * `ws` client's "Unexpected server response: 401", Bun's
   * "WebSocket connection to '…' failed: Expected 101 status code", a TLS
   * failure's own text. Logging only `evt.type` threw all of it away, and
   * `evt.type` is the constant string "error".
   *
   * `httpStatus` is present only on the `ws` path, which is handed the whole
   * HTTP reply before it errors. Bun carries no status field: 1.4.3 says
   * nothing of it, 1.4.4 quotes it in the message (`Expected 101 status code:
   * 401`) without the redirect target, so {@link probe} asks for it instead.
   */
  reportError(evt: Event): boolean {
    const detail = evt as {
      type: string;
      message?: string;
      httpStatus?: number;
      httpLocation?: string;
    };
    if (typeof detail.httpStatus === "number") {
      this.logger.error(
        describeRefusal(detail.httpStatus, detail.httpLocation),
        LogType.WEBSOCKET,
      );
      return true;
    }
    this.logger.error(
      detail.message
        ? // The client's message quotes the connection URL, which may carry
          // `user:password@host` credentials -- redact before logging.
          `WebSocket error: ${redactSensitiveText(detail.message)}`
        : `WebSocket error type: ${detail.type}`,
      LogType.WEBSOCKET,
    );
    return false;
  }

  /**
   * #288 — ask the CSMS why, when the client will not say.
   *
   * Replays the handshake `options` describe as one plain GET and logs the
   * status it answers with, at most once a minute. The caller decides that
   * the attempt was a refused upgrade whose status the client did not report,
   * and that the close was not a manual disconnect.
   */
  probe(options: OcppWebSocketConnectOptions | null, generation: number): void {
    if (!options) return;
    const now = Date.now();
    if (now - this.lastProbeAt < PROBE_INTERVAL_MS) return;
    this.lastProbeAt = now;
    // The probe is a round trip, and the reconnect loop may well win it. A
    // refusal logged against a charge point that is connected again reads as
    // a live problem, so the answer is dropped unless it still describes the
    // connection that asked the question.
    void probeUpgradeRefusal(options)
      .then((detail) => {
        if (!detail || !this.stillFailing(generation)) return;
        this.logger.error(
          `${describeRefusal(detail.status, detail.location)} (diagnostic GET after the handshake failed)`,
          LogType.WEBSOCKET,
        );
      })
      .catch(() => {
        // A diagnostic must never become a failure of its own.
      });
  }
}
