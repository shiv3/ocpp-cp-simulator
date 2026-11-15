import type { CallBehavior } from "@ocpp-cp-simulator/contracts/behavior";
import type { TimerHandle } from "../../shared/clock";

/** Thrown into a behavior's waits when it is unloaded or its connection ends. */
export class BehaviorStopped extends Error {
  constructor(message = "The behavior was stopped") {
    super(message);
    this.name = "BehaviorStopped";
  }
}

/** A `ctx.until` whose time ran out. */
export class BehaviorTimeout extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms`);
    this.name = "BehaviorTimeout";
  }
}

/**
 * A set of waits that is cancelled together. A behavior's `main` has one for
 * the life of the behavior; each CALL a behavior or a default behavior answers
 * has one that also ends when the connection does.
 */
export class Scope {
  /** `ctx.stopping`: the owner asked the work to wind down. */
  stopping = false;
  /** Waits reject: the work is cut off. A scope can be stopping a while before. */
  cancelled = false;
  private readonly cancels = new Map<TimerHandle, () => void>();

  constructor(
    readonly behaviorId: string,
    public connectionBound: boolean,
  ) {}

  track(handle: TimerHandle, cancel: () => void): void {
    this.cancels.set(handle, cancel);
  }

  untrack(handle: TimerHandle): void {
    this.cancels.delete(handle);
  }

  /** Ask the work to finish (`ctx.stopping` turns true); its waits keep working. */
  requestStop(): void {
    this.stopping = true;
  }

  cancel(): void {
    this.stopping = true;
    this.cancelled = true;
    for (const cancel of [...this.cancels.values()]) cancel();
    this.cancels.clear();
  }
}

/**
 * Default behaviors whose follow-up stops when the connection closes: the
 * firmware status trains, whose timers `ChargePoint` cleared on a close before
 * the engine. The log and diagnostics uploads were not tied to the socket and
 * go on across a reconnect. Rule 4 of docs/concepts/charger-engine.md: this is
 * the behavior of ca01d302, kept as it was.
 */
export const CONNECTION_BOUND_DEFAULTS: ReadonlySet<string> = new Set([
  "default.firmware",
  "default.signedFirmware",
]);

/** Per-CALL data a context needs. */
export interface CallEnv {
  readonly action: string;
  readonly mode: CallBehavior["mode"] | "default";
  /** Effects of default behaviors run through `ctx.defaultBehavior`. */
  readonly defaultEffects: Array<() => void>;
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export function jsonCopy(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
