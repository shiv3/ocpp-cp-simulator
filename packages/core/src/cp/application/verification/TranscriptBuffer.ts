/**
 * TranscriptBuffer.ts -- captures the OCPP wire transcript of one scenario
 * run (#179 Phase 2b) by subscribing to a ChargePoint's Logger for its
 * WebSocket-typed log entries and parsing each into a {@link Frame} (see
 * ocpp.ts). ScenarioAssertions.evaluateAssertions evaluates a scenario's
 * declared assertions against `frames` once the run ends.
 */

import { LogType } from "../../shared/Logger";
import type { Logger, LogEntry } from "../../shared/Logger";
import { parseFrameMessage, type Frame } from "./ocpp";

/**
 * A captured {@link Frame} plus its position in this buffer's capture
 * order. `Frame` is a discriminated union (CallFrame | CallResultFrame |
 * CallErrorFrame), so this is a type intersection rather than an
 * `interface extends` -- TypeScript interfaces cannot extend a union type.
 */
export type TranscriptFrame = Frame & { seq: number };

/**
 * Subscribes to a Logger's WebSocket log entries for the lifetime of one
 * scenario run and accumulates every Sent:/Received: frame it can parse,
 * in capture order. Non-frame WebSocket log entries (connection status,
 * parse-error warnings, ...) are silently skipped -- parseFrameMessage
 * returns null for them.
 */
export class TranscriptBuffer {
  private readonly _logger: Logger;
  private readonly _frames: TranscriptFrame[] = [];
  private _seq = 0;
  private _unsubscribe: (() => void) | null = null;

  constructor(logger: Logger) {
    this._logger = logger;
  }

  /**
   * Subscribes to the logger's WebSocket-typed log stream. Idempotent --
   * calling start() while already started is a no-op (won't double
   * subscribe and double-count frames).
   */
  start(): void {
    if (this._unsubscribe) return;
    // Logger.on returns its own unsubscribe closure (wraps
    // emitter.off(event, listener) internally), so capturing that is the
    // cleanest way to unsubscribe cleanly in stop() without holding a
    // separate reference to the listener function ourselves.
    this._unsubscribe = this._logger.on(
      `log.${LogType.WEBSOCKET}`,
      (entry: LogEntry) => {
        const frame = parseFrameMessage(
          entry.message,
          entry.timestamp.toISOString(),
        );
        if (frame) {
          this._frames.push({ ...frame, seq: this._seq });
          this._seq += 1;
        }
      },
    );
  }

  /** Unsubscribes from the logger. Safe to call multiple times, or before
   *  start() has ever been called. */
  stop(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  /** Captured frames, in capture order. */
  get frames(): readonly Frame[] {
    return this._frames;
  }
}
