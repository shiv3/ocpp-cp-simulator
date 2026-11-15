import type { JsonObject } from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../../cp/domain/charge-point/ChargePoint";
import { drainMicrotasks, VirtualClock } from "../../../cp/shared/clock";
import type { WireVersion } from "../FakeCsms";
import type { Rig, RigOptions } from "../rig";

/** One scripted run of a real ChargePoint against the fake CSMS. */
export interface GoldenCase {
  /** Fixture file name; unique across versions. */
  readonly name: string;
  readonly version: WireVersion;
  readonly options?: Partial<Omit<RigOptions, "version">>;
  /** Record with strict normalization (relative timestamps, id shape). */
  readonly strict?: boolean;
  readonly run: (rig: Rig) => Promise<void>;
}

export const PAST = "2020-01-01T00:00:00.000Z";

export const FUTURE = "2099-01-01T00:00:00.000Z";

export const c16 = (
  name: string,
  run: GoldenCase["run"],
  options?: GoldenCase["options"],
): GoldenCase => ({ name: `16-${name}`, version: "1.6", run, options });
export const c201 = (
  name: string,
  run: GoldenCase["run"],
  options?: GoldenCase["options"],
): GoldenCase => ({ name: `201-${name}`, version: "2.0.1", run, options });

/** A case that exists on both versions with one body. */
export const both = (
  name: string,
  run: GoldenCase["run"],
  options?: GoldenCase["options"],
): GoldenCase[] => [c16(name, run, options), c201(name, run, options)];

export const settle = (rig: Rig) => rig.csms.settle();

/**
 * A case on its own VirtualClock and the in-memory socket (#867): what the
 * station does "on the next turn of the clock" happens when `turn()` runs, not
 * after a real delay. One clock per version, since the cases run concurrently.
 */
export const bothVirtual = (
  name: string,
  run: (rig: Rig, turn: () => Promise<void>) => Promise<void>,
): GoldenCase[] =>
  [c16, c201].map((add) => {
    const clock = new VirtualClock();
    return add(
      name,
      (rig) =>
        run(rig, async () => {
          await clock.advanceBy(0);
          await drainMicrotasks();
        }),
      { memory: true, simulation: { clock, seed: "g867" } },
    );
  });

/** Select `default.firmware` params for the whole case (a code-owned layer). */
export const selectFirmware = (cp: ChargePoint, params: JsonObject): void =>
  cp.engine.activateBehavior(
    "default.firmware",
    { kind: "code", behaviorId: "golden" },
    params,
  );

export async function charging(rig: Rig, tag = "TAG-1"): Promise<void> {
  rig.plugIn();
  await settle(rig);
  await rig.startLocal(tag);
}

/** Wait for a CP-initiated frame that follows an action, then let it settle. */
export async function waitCall(
  rig: Rig,
  action: string,
  from: number,
  nth = 1,
): Promise<void> {
  let seen = 0;
  await rig.csms.waitForFrame(
    (f) => {
      if (f.dir === "CP>" && f.action === action) return ++seen === nth;
      return false;
    },
    { from, timeoutMs: 30_000 },
  );
  await settle(rig);
}

export function rig16or201(
  p: Record<string, unknown>,
): Record<string, unknown> {
  const tag = (p.idTag ??
    (p.idToken as { idToken?: string } | undefined)?.idToken) as string;
  const status = tag?.startsWith("CERT023-INV") ? "Invalid" : "Accepted";
  return "idTag" in p ? { idTagInfo: { status } } : { idTokenInfo: { status } };
}
