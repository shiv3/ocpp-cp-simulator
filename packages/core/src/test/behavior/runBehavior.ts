// The behavior test harness (docs/concepts/charger-engine.md, "Loading code"):
// a real ChargePoint on a VirtualClock with seeded streams, wired to the fake
// CSMS of the golden wire test, with behaviors loaded. Runs under `bun test`
// only (the fake CSMS uses Bun.serve).
import { createHash } from "node:crypto";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargerEngine } from "../../cp/application/engine/ChargerEngine";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import { drainMicrotasks, VirtualClock } from "../../cp/shared/clock";
import type {
  CsmsResponder,
  FakeCsms,
  WireFrame,
  WireVersion,
} from "../goldenWire/FakeCsms";
import { normalizeFrames } from "../goldenWire/normalize";
import { Rig } from "../goldenWire/rig";

export interface RunBehaviorOptions {
  readonly version: WireVersion;
  /** Loaded in order, after the station booted. */
  readonly behaviors?: readonly Behavior[];
  /** Same seed, same effects. */
  readonly seed?: string | number;
  readonly connectors?: number;
  readonly responders?: Readonly<Record<string, CsmsResponder>>;
  /** Run before the station connects (policies, configuration). */
  readonly beforeConnect?: (cp: ChargePoint) => void;
  /**
   * `memory` (default): the station and the fake CSMS talk over an in-memory
   * socket, so a virtual-time run waits for no real I/O and no real time.
   * `socket`: a real WebSocket on a loopback port, as the golden wire test
   * uses (the transport itself under test).
   */
  readonly transport?: "memory" | "socket";
  /** Socket transport only: real milliseconds of silence that end a step; default 60. */
  readonly quietMs?: number;
}

export interface BehaviorRun {
  readonly cp: ChargePoint;
  readonly csms: FakeCsms;
  readonly clock: VirtualClock;
  readonly version: WireVersion;
  /** Frames recorded from the moment the behaviors were loaded. */
  frames(): readonly WireFrame[];
  /** CP-initiated CALLs with this action since the behaviors were loaded. */
  callsOf(action: string): WireFrame[];
  /** Move virtual time forward and wait for the traffic that follows. */
  advance(ms: number): Promise<void>;
  /**
   * Like `advance`, in steps of `stepMs` with the traffic settled after each.
   * A behavior or scenario that waits for an answer of the (real) fake CSMS
   * between two waits only arms its next timer once that answer arrived, so a
   * single long jump would sweep past it.
   */
  advanceInSteps(ms: number, stepMs?: number): Promise<void>;
  /** Let pending traffic settle without moving time. */
  settle(): Promise<void>;
  /** A CSMS CALL; resolves with the station's answer. */
  call(action: string, payload: unknown): Promise<WireFrame>;
  /** A CSMS CALL without waiting for its answer; returns the message id. */
  callNoWait(action: string, payload: unknown): string;
  /** Hash of the ordered, normalized frames since the behaviors were loaded. */
  effectHash(): string;
  dispose(): Promise<void>;
}

export async function runBehavior(
  options: RunBehaviorOptions,
): Promise<BehaviorRun> {
  const clock = new VirtualClock();
  const quietMs = options.quietMs ?? 60;
  const rig = await Rig.create({
    version: options.version,
    ...(options.connectors === undefined
      ? {}
      : { connectors: options.connectors }),
    ...(options.responders === undefined
      ? {}
      : { responders: options.responders }),
    ...(options.beforeConnect === undefined
      ? {}
      : { beforeConnect: options.beforeConnect }),
    ...(options.transport === "socket" ? {} : { memory: true }),
    simulation: { clock, seed: options.seed ?? "behavior-harness" },
    noConnect: true,
  });
  const { cp, csms } = rig;
  // A real hop first: with no traffic in flight the fake CSMS reports quiet at
  // once, and the work that follows a virtual timer (scenario nodes, behavior
  // continuations) still needs its turn.
  const settleOnce = async (): Promise<void> => {
    if (csms.memory) {
      await csms.settle();
      await drainMicrotasks();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    await csms.settle(quietMs);
    await drainMicrotasks();
  };
  // A behavior that keeps something in `ctx.state` that cannot be stored fails
  // the test here; the daemon only warns and keeps the last storable value.
  const settle = async (): Promise<void> => {
    await settleOnce();
    (cp.engine as ChargerEngine).assertStorableState();
  };
  // A failed run returns no `dispose()`, so a boot, a refused behavior or a
  // first settle that throws tears the rig down here: otherwise the station
  // stays connected and the memory transport's WebSocket patch outlives the
  // test file (#803).
  let origin: number;
  try {
    await rig.connectAndBoot();
    origin = csms.mark();
    for (const behavior of options.behaviors ?? []) cp.loadBehavior(behavior);
    await settle();
  } catch (error) {
    await rig.dispose();
    throw error;
  }

  const frames = (): readonly WireFrame[] => csms.frames.slice(origin);
  return {
    cp,
    csms,
    clock,
    version: options.version,
    frames,
    callsOf: (action) =>
      frames().filter(
        (f) => f.dir === "CP>" && f.kind === "call" && f.action === action,
      ),
    async advance(ms) {
      await clock.advanceBy(ms);
      await settle();
    },
    async advanceInSteps(ms, stepMs = 500) {
      for (let left = ms; left > 0; left -= stepMs) {
        await clock.advanceBy(Math.min(stepMs, left));
        await settle();
      }
    },
    settle,
    call: (action, payload) => csms.call(action, payload),
    callNoWait: (action, payload) => csms.callNoWait(action, payload),
    effectHash: () =>
      createHash("sha256")
        .update(normalizeFrames(frames()).join("\n"))
        .digest("hex"),
    dispose: () => rig.dispose(),
  };
}
