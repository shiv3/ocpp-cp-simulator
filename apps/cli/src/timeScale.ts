import {
  realClock,
  ScaledClock,
  type SimClock,
} from "@ocpp-cp-simulator/core/cp/shared/clock";

/**
 * `--time-scale <N>` (process-wide): every charge point this process builds
 * runs on a clock N times faster than the wall clock, so a scenario that waits
 * minutes finishes in minutes / N. 1 (the default) is the platform clock.
 *
 * Process-wide on purpose: the flag is read once at startup, before any charge
 * point exists, and a daemon's charge points all share the pace of the run.
 * It is not persisted with a charge point.
 */
export const MAX_TIME_SCALE = 10_000;

let processTimeScale = 1;

export function setProcessTimeScale(scale: number): void {
  if (!Number.isFinite(scale) || scale <= 0 || scale > MAX_TIME_SCALE) {
    throw new RangeError(
      `time scale must be above 0 and at most ${MAX_TIME_SCALE}, got ${String(scale)}`,
    );
  }
  processTimeScale = scale;
}

export function getProcessTimeScale(): number {
  return processTimeScale;
}

/** The `simulation` argument of a new charge point: the process clock when sped up, else none. */
export function processSimulationOptions(): { clock?: SimClock } {
  return processTimeScale === 1 ? {} : { clock: processClock() };
}

/** The clock a new charge point of this process reads (the platform clock at scale 1). */
export function processClock(): SimClock {
  return processTimeScale === 1 ? realClock : new ScaledClock(processTimeScale);
}
