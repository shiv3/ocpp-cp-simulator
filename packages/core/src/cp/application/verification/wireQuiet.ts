import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import { clockOf, realClock } from "../../shared/clock";
import type { TimerHandle } from "../../shared/clock";
import { LogType } from "../../shared/Logger";
import type { LogEntry } from "../../shared/Logger";
import { parseFrameMessage } from "./ocpp";

export interface WireQuietOptions {
  /** No frame for this long (and nothing awaiting an answer) is quiet. */
  readonly quietMs?: number;
  /** Give up waiting after this long; the run ends regardless. */
  readonly maxMs?: number;
}

/** How {@link waitForWireQuiet} ended (#1091). */
export interface WireQuietOutcome {
  /** `quiet`: nothing outstanding and no frame for `quietMs`. `timeout`: still
   *  busy after `maxMs`. `offline`: the link is down, nothing can go out.
   *  `virtual_clock`: the station runs on a virtual clock, which this wait
   *  cannot advance, so it answers at once. */
  readonly reason: "quiet" | "timeout" | "offline" | "virtual_clock";
  /** CALLs the station sent that no answer has arrived for yet. */
  readonly outstandingCalls: number;
}

export const WIRE_QUIET_MS = 250;
export const WIRE_QUIET_MAX_MS = 2_000;

/**
 * Resolves once the charge point's WebSocket has gone quiet: every CALL it
 * sent has been answered and no frame crossed the wire for `quietMs`, or
 * `maxMs` has passed, or the link is down (nothing more can go out on it).
 *
 * A scenario ends the moment its last node returns, but the frames that last
 * node caused (a fire-and-forget DataTransfer behind the 1.6 one-CALL-in-flight
 * queue, the StopTransaction.conf and the status changes that follow a stop)
 * go out after it. Closing the run's transcript at that instant cut them off,
 * so assertions on them failed although they were on the wire. The scenario
 * runtime waits here before it completes the run.
 */
export function whenWireQuiet(
  chargePoint: ChargePoint,
  options: WireQuietOptions = {},
): Promise<void> {
  return waitForWireQuiet(chargePoint, options).then(() => undefined);
}

/**
 * {@link whenWireQuiet} that says how it ended. The control plane's
 * `wait_quiet` command (#1091) returns this.
 */
export function waitForWireQuiet(
  chargePoint: ChargePoint,
  options: WireQuietOptions = {},
): Promise<WireQuietOutcome> {
  const quietMs = options.quietMs ?? WIRE_QUIET_MS;
  const maxMs = options.maxMs ?? WIRE_QUIET_MAX_MS;
  const clock = clockOf(chargePoint);
  // Nothing goes out on a link that is down.
  if (!chargePoint.isOnline()) {
    return Promise.resolve({ reason: "offline", outstandingCalls: 0 });
  }
  // A virtual clock only moves when its owner advances it: waiting on it here
  // would park the run until someone does, and such stations are driven step
  // by step anyway.
  if (clock !== realClock) {
    return Promise.resolve({ reason: "virtual_clock", outstandingCalls: 0 });
  }
  return new Promise<WireQuietOutcome>((resolve) => {
    const awaiting = new Set<string>();
    let quietTimer: TimerHandle | null = null;
    let maxTimer: TimerHandle | null = null;
    let unsubscribe: (() => void) | null = null;
    let done = false;

    const finish = (reason: WireQuietOutcome["reason"]): void => {
      if (done) return;
      done = true;
      if (quietTimer !== null) clock.clearTimeout(quietTimer);
      if (maxTimer !== null) clock.clearTimeout(maxTimer);
      unsubscribe?.();
      resolve({ reason, outstandingCalls: awaiting.size });
    };
    const armQuiet = (): void => {
      if (quietTimer !== null) clock.clearTimeout(quietTimer);
      quietTimer = clock.setTimeout(() => {
        if (awaiting.size === 0) finish("quiet");
        else if (!chargePoint.isOnline()) finish("offline");
      }, quietMs);
    };

    unsubscribe = chargePoint.logger.on(
      `log.${LogType.WEBSOCKET}`,
      (entry: LogEntry) => {
        const frame = parseFrameMessage(
          entry.message,
          entry.timestamp.toISOString(),
        );
        if (!frame) return;
        if (frame.kind === "call") {
          if (frame.direction === "sent") awaiting.add(frame.uniqueId);
        } else if (frame.direction === "received") {
          awaiting.delete(frame.uniqueId);
        }
        armQuiet();
      },
    );
    maxTimer = clock.setTimeout(() => finish("timeout"), maxMs);
    armQuiet();
  });
}
