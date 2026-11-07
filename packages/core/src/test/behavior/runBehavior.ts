// The behavior test harness (docs/analyses/charger-engine.md, "Loading code"):
// a real ChargePoint on a VirtualClock with seeded streams, wired to the fake
// CSMS of the golden wire test, with behaviors loaded. Runs under `bun test`
// only (the fake CSMS uses Bun.serve).
import { createHash } from "node:crypto";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import { VirtualClock } from "../../cp/shared/clock";
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
  /** Real milliseconds of silence that end a step; default 60. */
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
    simulation: { clock, seed: options.seed ?? "behavior-harness" },
    noConnect: true,
  });
  const { cp, csms } = rig;
  await rig.connectAndBoot();
  const origin = csms.mark();
  for (const behavior of options.behaviors ?? []) cp.loadBehavior(behavior);
  const settle = (): Promise<void> => csms.settle(quietMs);
  await settle();

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
