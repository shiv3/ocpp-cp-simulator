// One virtual charge point of a load test: the simulator's real `ChargePoint`
// and `ScenarioExecutor` (the same code the daemon runs), driven from a k6 VU.
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { evaluateAssertions } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioAssertions";
import {
  parseFrameMessage,
  type Frame,
} from "@ocpp-cp-simulator/core/cp/application/verification/ocpp";
import { ScenarioExecutor } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioRuntime";
import type {
  AssertionResult,
  AssertionSpec,
  ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import { createChargePoint } from "@ocpp-cp-simulator/core/cp/infrastructure/charge-point/createChargePoint";
import { createHeadlessServices } from "@ocpp-cp-simulator/core/cp/infrastructure/charge-point/createHeadlessServices";
import { EventEmitter } from "@ocpp-cp-simulator/core/cp/shared/EventEmitter";
import { LogLevel } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import { FrameMeter, type FrameEvents } from "./frameMeter";

export type Profile = "steady" | "once" | "soak";

export interface ChargerOptions {
  readonly id: string;
  /** Base OCPP-J URL; the transport appends the charge point id. */
  readonly csmsUrl: string;
  /** HTTP Basic password (security profile 1); the user name is the id. */
  readonly basicPassword?: string;
  /** The scenario JSON to run, when the export has one. */
  readonly scenario?: ScenarioDefinition;
  /** Behaviors every charger loads (the engine runs them natively). */
  readonly behaviors?: readonly Behavior[];
  /**
   * `steady`: run the scenario again and again until the deadline.
   * `once`: run it one time and disconnect. `soak`: run it one time, then stay
   * connected until the deadline. Without a scenario `steady` and `soak`
   * just stay connected (behaviors and the CSMS drive the station).
   */
  readonly profile: Profile;
  /** Epoch ms after which no new cycle starts and the charger disconnects. */
  readonly deadlineAt: number;
  readonly startDelayMs: number;
  readonly connectors: number;
  readonly seed?: string;
  /** `MeterValueSampleInterval` to configure, in seconds. */
  readonly meterValueSampleIntervalS?: number;
  readonly bootTimeoutMs?: number;
}

/** What a charger reports; the generated script turns it into k6 metrics. */
export interface ChargerHooks extends FrameEvents {
  boot(accepted: boolean, durationMs: number): void;
  cycle(ok: boolean, durationMs: number): void;
  assertion(id: string, ok: boolean): void;
  log(message: string): void;
}

/** Wait for `ms`, resolving early when the promise settles; never leaves a timer behind. */
function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Build the station. Exported for the smoke tests; `runCharger` is the entry. */
export function createLoadChargePoint(o: ChargerOptions): ChargePoint {
  const cp = createChargePoint(
    o.id,
    { ...DefaultBootNotification, chargePointSerialNumber: o.id },
    Math.max(1, o.connectors),
    o.csmsUrl,
    o.basicPassword ? { username: o.id, password: o.basicPassword } : null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    o.seed !== undefined ? { seed: `${o.seed}:${o.id}` } : {},
    createHeadlessServices(),
  );
  // Only errors reach the (shared) console, and no entry list grows in a
  // station nobody inspects.
  cp.logger.setLevel(LogLevel.ERROR);
  cp.logger.setMaxEntries(0);
  if (o.meterValueSampleIntervalS) {
    cp.configuration.setRuntimeValue(
      "MeterValueSampleInterval",
      o.meterValueSampleIntervalS,
    );
  }
  return cp;
}

/** Drive one charge point from its start delay until its deadline. */
export async function runCharger(
  o: ChargerOptions,
  hooks: ChargerHooks,
): Promise<void> {
  await sleep(o.startDelayMs);
  if (Date.now() >= o.deadlineAt) return;
  const cp = createLoadChargePoint(o);
  const assertionSpecs = (o.scenario?.assertions ?? []) as AssertionSpec[];
  let frames: Frame[] = [];
  const meter = new FrameMeter(hooks);
  const stopFrames = cp.onWireFrame((direction, raw) => {
    meter.observe(direction, raw);
    if (assertionSpecs.length > 0) {
      const frame = parseFrameMessage(
        `${direction === "sent" ? "Sent" : "Received"}: ${raw}`,
        new Date().toISOString(),
      );
      if (frame) frames.push(frame);
    }
  });
  try {
    for (const behavior of o.behaviors ?? []) cp.loadBehavior(behavior);
    const bootStart = Date.now();
    let accepted = false;
    const booted = new Promise<void>((resolve) => {
      cp.events.on("bootNotificationResult", (r) => {
        accepted = r.status === "Accepted";
        resolve();
      });
    });
    cp.connect();
    await raceTimeout(booted, o.bootTimeoutMs ?? 15000);
    hooks.boot(accepted, Date.now() - bootStart);
    if (!accepted) {
      // The station keeps retrying on its own; do not run a scenario on a
      // station the CSMS has not registered.
      await sleep(Math.max(0, Math.min(o.deadlineAt - Date.now(), 5000)));
      return;
    }

    const scenario = o.scenario;
    if (scenario) {
      const connector = cp.connectors.get(scenario.targetId ?? 1);
      if (!connector) {
        hooks.log(
          `${o.id}: scenario targets connector ${scenario.targetId}, which does not exist`,
        );
        hooks.cycle(false, 0);
        return;
      }
      do {
        frames = [];
        const started = Date.now();
        const events = new EventEmitter<never>();
        const callbacks = createScenarioExecutorCallbacks({
          chargePoint: cp,
          connector,
        });
        const executor = new ScenarioExecutor(
          scenario,
          callbacks,
          events as never,
          { clock: cp.clock },
        );
        // A scenario that waits past the deadline is cut short, not abandoned.
        const cutoff = setTimeout(
          () => executor.stop(),
          Math.max(0, o.deadlineAt - Date.now()),
        );
        let thrown: string | undefined;
        try {
          await executor.start();
        } catch (error) {
          thrown = error instanceof Error ? error.message : String(error);
        } finally {
          clearTimeout(cutoff);
        }
        const context = executor.getContext();
        const results: AssertionResult[] =
          assertionSpecs.length > 0
            ? evaluateAssertions(assertionSpecs, frames)
            : [];
        for (const r of results) hooks.assertion(r.id, r.status === "passed");
        const ok =
          thrown === undefined &&
          context.state === "completed" &&
          results.every((r) => r.status === "passed");
        const cut = Date.now() >= o.deadlineAt && context.state !== "completed";
        if (!cut) hooks.cycle(ok, Date.now() - started);
        if (!ok && !cut) {
          hooks.log(
            `${o.id}: scenario ${context.state}${(thrown ?? context.error) ? `: ${thrown ?? context.error}` : ""}`,
          );
          // Back off so a scenario that fails at once does not spin.
          await sleep(1000);
        }
      } while (o.profile === "steady" && Date.now() < o.deadlineAt);
    }
    if (o.profile !== "once") {
      await sleep(o.deadlineAt - Date.now());
    }
  } finally {
    stopFrames();
    cp.dispose();
  }
}
