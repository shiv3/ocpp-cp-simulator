// packages/k6-runtime/src/behaviorRun.ts
// One k6 iteration of a behavior load test: connect the charge points of this
// VU, run the behaviors on them, and end in time. Every wait is a k6 timer
// (never k6 `sleep()`), so one VU can drive several charge points and the
// iteration can always be stopped.
import exec from "k6/execution";
import { clearTimeout, setTimeout } from "k6/timers";
import { BehaviorHost, type CannedResponses } from "./behaviorHost.ts";
import type { Behavior } from "./behaviorTypes.ts";
import { OcppChargePoint } from "./ocppClient.ts";
import type { CpIdentity, Wire } from "./types.ts";

/** An iteration with no `main` and no RUN_FOR_MS serves CALLs this long. */
export const DEFAULT_HOLD_MS = 60_000;
/** The stop of an iteration (rejecting waits, letting mains settle) is
 *  bounded by this; k6's own gracefulStop starts counting after it. */
const STOP_MARGIN_MS = 2_000;

export interface BehaviorRunOptions {
  behaviors: readonly Behavior[];
  /** See BehaviorHostOptions.canned. */
  canned?: CannedResponses;
  env: Record<string, string | undefined>;
  vu: number;
  url: string;
  wire: Wire;
  identities: CpIdentity[] | null;
  log?: (message: string) => void;
}

/** "30s", "5m", "1h30m", "250ms" -> ms; null when it is not a duration. */
export function parseDurationMs(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    consumed += m[0].length;
    const n = Number.parseFloat(m[1]);
    total +=
      m[2] === "ms"
        ? n
        : m[2] === "s"
          ? n * 1000
          : m[2] === "m"
            ? n * 60_000
            : n * 3_600_000;
  }
  return consumed === raw.length && consumed > 0 ? total : null;
}

/** The identities of the charge points of one VU. */
export function identitiesOfVu(
  env: Record<string, string | undefined>,
  identities: CpIdentity[] | null,
  vu: number,
): CpIdentity[] {
  const per = Number.parseInt(env.CHARGERS_PER_VU ?? "1", 10);
  if (!Number.isInteger(per) || per < 1) {
    throw new Error(
      `Invalid CHARGERS_PER_VU "${env.CHARGERS_PER_VU}" (expected a positive integer)`,
    );
  }
  const out: CpIdentity[] = [];
  for (let i = 0; i < per; i++) {
    if (identities !== null) {
      out.push(identities[((vu - 1) * per + i) % identities.length]);
      continue;
    }
    const template = env.CP_ID_TEMPLATE ?? "CP-${__VU}";
    const base = template.replace(/\$\{__VU\}/g, String(vu));
    const cpId = per === 1 ? base : `${base}-${i + 1}`;
    const pw = env.BASIC_AUTH_PASSWORD;
    out.push(
      pw !== undefined && pw !== "" ? { cpId, basicPassword: pw } : { cpId },
    );
  }
  return out;
}

/** When the iteration has to start stopping (epoch ms), or null for "when the
 *  mains are done". */
export function stopAtMs(
  env: Record<string, string | undefined>,
  nowMs: number,
  scenarioStartMs: number,
  hasMain: boolean,
): number | null {
  const candidates: number[] = [];
  if (env.RUN_FOR_MS !== undefined && env.RUN_FOR_MS !== "") {
    const n = Number.parseInt(env.RUN_FOR_MS, 10);
    if (!Number.isInteger(n) || n < 1 || String(n) !== env.RUN_FOR_MS) {
      throw new Error(
        `Invalid RUN_FOR_MS "${env.RUN_FOR_MS}" (expected milliseconds as a positive integer)`,
      );
    }
    candidates.push(nowMs + n);
  }
  // constant-vus profiles end at DURATION: stop in time for k6's own
  // gracefulStop never to be needed.
  if ((env.PROFILE ?? "steady") !== "spike") {
    const duration = parseDurationMs(env.DURATION ?? undefined);
    if (duration !== null) {
      candidates.push(scenarioStartMs + duration - STOP_MARGIN_MS);
    }
  }
  if (candidates.length === 0) return hasMain ? null : nowMs + DEFAULT_HOLD_MS;
  return Math.min(...candidates);
}

export interface BehaviorRunResult {
  ok: boolean;
  /** True when the iteration did nothing: the run was about to end. */
  skipped: boolean;
  problems: string[];
}

export async function runBehaviorIteration(
  opts: BehaviorRunOptions,
): Promise<BehaviorRunResult> {
  const log = opts.log ?? ((m: string): void => console.log(m));
  const seed = opts.env.SEED ?? `${Date.now()}-${opts.vu}`;
  const timers = { setTimeout, clearTimeout };
  const ids = identitiesOfVu(opts.env, opts.identities, opts.vu);
  const problems: string[] = [];
  // The last seconds of a constant-vus run: k6 would loop through
  // connect-and-stop iterations until the end. Wait it out instead.
  if ((opts.env.PROFILE ?? "steady") !== "spike") {
    const duration = parseDurationMs(opts.env.DURATION ?? undefined);
    if (duration !== null) {
      const end = exec.scenario.startTime + duration;
      if (Date.now() >= end - STOP_MARGIN_MS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.max(0, end - Date.now()));
        });
        return { ok: true, skipped: true, problems };
      }
    }
  }
  const cps = ids.map(
    (identity) =>
      new OcppChargePoint({
        url: opts.url,
        identity,
        wire: opts.wire,
        connectorId: 1,
      }),
  );
  const hosts: BehaviorHost[] = [];
  try {
    const connected = await Promise.all(
      cps.map((cp) =>
        cp.connect().then(
          () => true,
          (err: unknown) => {
            problems.push(
              `${cp.cpId}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
          },
        ),
      ),
    );
    cps.forEach((cp, i) => {
      if (!connected[i]) return;
      const host = new BehaviorHost({
        cp,
        behaviors: opts.behaviors,
        timers,
        seed,
        ...(opts.canned === undefined ? {} : { canned: opts.canned }),
        log: (m) => log(`[${cp.cpId}] ${m}`),
      });
      host.start();
      hosts.push(host);
    });
    if (hosts.length > 0) {
      const hasMain = hosts.some((h) => h.hasMain);
      const stopAt = stopAtMs(
        opts.env,
        Date.now(),
        exec.scenario.startTime,
        hasMain,
      );
      const allMains = Promise.all(hosts.map((h) => h.mainsDone())).then(
        () => undefined,
      );
      // RUN_FOR_MS is a length: the iteration lasts that long even if the
      // mains returned (the rules keep answering). Without it a behavior with
      // a `main` ends with its mains.
      const lasts = (opts.env.RUN_FOR_MS ?? "") !== "" || !hasMain;
      const waits: Array<Promise<void>> = [];
      if (!lasts) waits.push(allMains);
      let id = -1;
      if (stopAt !== null) {
        waits.push(
          new Promise<void>((resolve) => {
            id = setTimeout(resolve, Math.max(0, stopAt - Date.now()));
          }),
        );
      }
      await Promise.race(waits);
      clearTimeout(id);
    }
  } finally {
    const left = await Promise.all(
      hosts.map((h) => h.stop(STOP_MARGIN_MS - 500)),
    );
    for (const ids of left) {
      for (const id of ids)
        problems.push(`main of "${id}" did not stop in time`);
    }
    for (const cp of cps) cp.close();
  }
  return { ok: problems.length === 0, skipped: false, problems };
}
