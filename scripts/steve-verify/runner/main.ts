#!/usr/bin/env bun
/**
 * main.ts -- TypeScript steve-verify runner CLI.
 *
 * Usage: bun scripts/steve-verify/runner/main.ts run <template-id> \
 *          [--cp CERTCP1] [--timeout N] [--connector N]
 *        bun scripts/steve-verify/runner/main.ts run --group core|authlist-reservation|remotetrigger-smartcharging|firmware|all [--parallel]
 *        bun scripts/steve-verify/runner/main.ts run-all [--group <name>] [--parallel]
 *
 * Brings its own simulator container up (sim.ts, mirrors lib.sh's
 * sim_start), drives it over the JSON-Lines stdin protocol, captures its
 * full stdout, parses OCPP-J frames (ocpp.ts) and runs the named spec's
 * drive()/assert() against a live SteVe instance (steve.ts). Task 1 wired
 * the runner core + two scenarios directly here; Task 2 grew a specs/
 * directory (typed spec objects per group) + a sequential `run --group`
 * sweep on top of the same runScenario() core; Task 3 finishes the spec
 * registry (remotetrigger-smartcharging + firmware), adds `--parallel`
 * (per-CP lanes, mirroring run-all.sh's batching), the `run-all` alias
 * (mirrors run-all.sh's own CLI exactly: GROUP defaults to "all"), and the
 * results/summary.md writer.
 */

import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AssertRecorder } from "./assert";
import { parseLog } from "./ocpp";
import { defaultSimConfig, startSim } from "./sim";
import { defaultSteveApiConfig, SteveApiOps } from "./steve-api";
import { defaultSteveConfig, SteveDb, SteveUiOps } from "./steve";
import type { SteveOps } from "./steve";
import {
  AUTHLIST_RESERVATION_SPECS,
  AUTHORIZE_SPECS,
  CORE_SPECS,
  FIRMWARE_SPECS,
  REMOTETRIGGER_SMARTCHARGING_SPECS,
} from "./specs/index";
import type { ScenarioSpec } from "./spec-types";
import { sleep } from "./util";

// scripts/steve-verify/runner/main.ts is 3 directories below the repo root.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// scripts/steve-verify/results/ -- one directory up from runner/, same
// location run-all.sh's $RESULTS_DIR writes to (gitignored).
const RESULTS_DIR = fileURLToPath(new URL("../results/", import.meta.url));

// ---------------------------------------------------------------------------
// Runner core
// ---------------------------------------------------------------------------

interface RunOptions {
  cpId: string;
  connector?: number;
  timeoutSecs?: number;
}

/**
 * Issue #184 Task 2: picks the SteveOps driver for this run.
 * `STEVE_DRIVER=api` (or unset -- REST is now the default) uses
 * SteveApiOps (steve-api.ts, SteVe 3.13.0's typed `/api/v1/operations/*`);
 * `STEVE_DRIVER=ui` falls back to SteveUiOps (steve.ts, the manager-UI
 * form-POST client this runner used exclusively through Task 1). Every
 * spec drives CSMS operations only through the SteveOps surface
 * (steve.op()/steve.cpSelect()), so which driver is active is invisible
 * to specs/*.ts.
 */
function createSteveOps(env: NodeJS.ProcessEnv = process.env): SteveOps {
  const driver = (env.STEVE_DRIVER ?? "api").toLowerCase();
  if (driver === "ui") {
    return new SteveUiOps(defaultSteveConfig(env));
  }
  if (driver !== "api") {
    process.stderr.write(
      `[runner] WARN: unrecognized STEVE_DRIVER="${env.STEVE_DRIVER}" -- falling back to "api"\n`,
    );
  }
  return new SteveApiOps(defaultSteveApiConfig(env));
}

async function runScenario<D>(
  spec: ScenarioSpec<D>,
  options: RunOptions,
): Promise<AssertRecorder> {
  const connector = options.connector ?? spec.connector ?? 1;
  const bootWaitSecs = spec.bootWaitSecs ?? 4;
  const holdSecs = options.timeoutSecs ?? spec.holdSecs ?? 20;

  const simCfg = defaultSimConfig(REPO_ROOT);
  const steveCfg = defaultSteveConfig();
  const db = new SteveDb(steveCfg);
  // A fresh driver instance per runScenario() call (one per parallel lane)
  // -- preserves the per-lane isolation Task 1's Finding 4 investigation
  // relied on (see main.ts's isolation note further down); SteveApiOps is
  // additionally stateless (no cookie jar at all, unlike SteveUiOps), so
  // this instantiation is cheap either way.
  const steve = createSteveOps();

  await db.closeStaleTx(options.cpId);

  process.stderr.write(
    `[runner] === ${spec.templateId} on ${options.cpId} (connector ${connector}, boot-wait ${bootWaitSecs}s, hold ${holdSecs}s, ` +
      `steve driver ${(process.env.STEVE_DRIVER ?? "api").toLowerCase()}) ===\n`,
  );

  const sim = await startSim(options.cpId, spec.templateId, simCfg);
  process.stderr.write(`[runner] simulator container: ${sim.container}\n`);

  let driveState!: D;
  try {
    await sim.send({ command: "connect" });
    // Post-boot stdin method, made event-driven: the bash feeder (and Task
    // 1/2 of this runner) approximated "past BootNotification.conf" with
    // the fixed bootWaitSecs sleep alone. Under --parallel, three
    // simultaneous `docker run` cold starts can push connect+boot past
    // that fixed wait, and then run_scenario_template fires while the CP
    // is still booting -- either the scenario's opening traffic is dropped
    // by the boot gate (observed live: tc028's StartTransaction never hit
    // the wire) or the command lands before the CLI is ready at all
    // (observed live: tc057 never emitted scenario_started). Wait for the
    // actual BootNotification.conf line (bounded, warn-and-continue on
    // timeout like every other soft wait here), THEN apply the spec's
    // bootWaitSecs settle on top, preserving each spec's tuned timing.
    try {
      await sim.waitForLine(
        /Received: \[3,.*"status":"Accepted","currentTime"/,
        30_000,
      );
    } catch (err) {
      process.stderr.write(
        `[runner] WARN: did not see BootNotification.conf within 30s -- continuing anyway (${
          err instanceof Error ? err.message : String(err)
        })\n`,
      );
    }
    await sleep(bootWaitSecs * 1000);
    await sim.send({
      command: "run_scenario_template",
      params: { connector, templateId: spec.templateId },
    });

    try {
      await sim.waitForLine(/"event":"scenario_started"/, 20_000);
    } catch (err) {
      process.stderr.write(
        `[runner] WARN: did not see scenario_started within 20s -- continuing anyway, assert() will likely fail if the scenario never ran (${
          err instanceof Error ? err.message : String(err)
        })\n`,
      );
    }

    if (spec.drive) {
      process.stderr.write(`[runner] running drive() for ${spec.templateId}\n`);
      driveState = await spec.drive({
        cpId: options.cpId,
        connector,
        sim,
        steve,
        db,
      });
    } else {
      process.stderr.write(
        `[runner] no drive() defined (CP-only scenario) -- nothing to do while it runs\n`,
      );
      driveState = undefined as D;
    }

    await sleep(holdSecs * 1000);
  } finally {
    await sim.stop();
  }

  const lines = sim.lines;

  // Persist the full captured wire log to results/<template-id>.log --
  // same artifact run-scenario.sh wrote (results/ is gitignored). Without
  // it a FAIL in a swept scenario is un-post-mortem-able: the sim container
  // is already stopped+removed by the time assert() reports, so this
  // capture is the only surviving record of what was (or wasn't) on the
  // wire. Best-effort: a write failure must not turn a finished scenario
  // run into an error.
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    await Bun.write(
      `${RESULTS_DIR}${spec.templateId}.log`,
      lines.join("\n") + "\n",
    );
  } catch (err) {
    process.stderr.write(
      `[runner] WARN: could not write results/${spec.templateId}.log: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  const frames = parseLog(lines.join("\n"));
  const rec = new AssertRecorder();

  process.stderr.write(`[runner] running assert() for ${spec.templateId}\n`);
  await spec.assert({
    cpId: options.cpId,
    connector,
    frames,
    lines,
    rec,
    db,
    driveState,
  });

  for (const check of rec.results) {
    if (check.pass) {
      process.stdout.write(`  PASS: ${check.description}\n`);
    } else {
      process.stdout.write(`  FAIL: ${check.description}\n`);
      if (check.detail) process.stdout.write(`        ${check.detail}\n`);
    }
  }
  process.stderr.write(
    `[runner] RESULT: ${spec.templateId} ${rec.verdict} (${rec.total} checks, ${rec.failed} failed)\n`,
  );

  return rec;
}

// ---------------------------------------------------------------------------
// Spec registry -- groups mirror run-all.sh's group names and array
// membership/order exactly (44 scenarios total: 15 core + 13
// authlist-reservation + 12 remotetrigger-smartcharging + 4 firmware).
//
// "authorize" (issue #181's 3 TC_023 Authorize-outcome scenarios) is a
// separate group, deliberately NOT folded into "all" -- run-all --parallel
// stays at its existing 44-scenario baseline; run `run-all --group
// authorize` (3 scenarios) as its own sweep.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GROUPS: Record<string, ScenarioSpec<any>[]> = {
  core: CORE_SPECS,
  "authlist-reservation": AUTHLIST_RESERVATION_SPECS,
  "remotetrigger-smartcharging": REMOTETRIGGER_SMARTCHARGING_SPECS,
  firmware: FIRMWARE_SPECS,
  authorize: AUTHORIZE_SPECS,
  // Concatenation order mirrors run-all.sh's `all)` case exactly: CORE +
  // AUTHLIST_RESERVATION + REMOTETRIGGER_SMARTCHARGING + FIRMWARE.
  all: [
    ...CORE_SPECS,
    ...AUTHLIST_RESERVATION_SPECS,
    ...REMOTETRIGGER_SMARTCHARGING_SPECS,
    ...FIRMWARE_SPECS,
  ],
};

// Built from every group (not just "all") so `run <template-id>` also
// resolves specs from groups intentionally excluded from "all" (e.g.
// "authorize" -- see the GROUPS comment above). Map construction dedupes
// the same spec object appearing under both its own group and "all".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SPECS_BY_TEMPLATE_ID = new Map<string, ScenarioSpec<any>>(
  Object.values(GROUPS)
    .flat()
    .map((spec) => [spec.templateId, spec]),
);

// Round-robins scenarios across CERTCP1..3 so adjacent scenarios in a group
// sweep don't collide on the same charge point's transaction state --
// mirrors run-all.sh's CP_FOR assignment (computed once over the whole
// SCENARIOS array for the group being run, including "all").
const GROUP_CPS = ["CERTCP1", "CERTCP2", "CERTCP3"];

// ---------------------------------------------------------------------------
// Group sweep -- sequential (default) or parallel (up to 3 concurrent, one
// per CERTCP1..3 lane, batched in groups of 3 exactly like run-all.sh's
// `pids=(); for bid in batch; do run_one & ...; done; wait` loop).
// ---------------------------------------------------------------------------

interface ScenarioOutcome {
  templateId: string;
  cpId: string;
  verdict: "PASS" | "FAIL" | "ERROR";
  /** null only for ERROR (the scenario threw before producing an
   *  AssertRecorder -- e.g. a bounded wait's fail-hard timeout escaping
   *  drive()/assert() uncaught). Mirrors run-all.sh's summary row for a
   *  scenario whose .result file was never written ("ERROR | - | -"). */
  checks: number | null;
  failed: number | null;
  errorMessage?: string;
  /**
   * --retry-failed-isolated safety net (issue #184 Finding 4): set only for
   * an outcome whose PARALLEL verdict was not PASS, re-run once sequentially
   * (same CP, no concurrent lane) on the SAME SteVe/DB, so any difference is
   * attributable to parallel-lane contention rather than a spec/environment
   * change. isolatedRetry.verdict === "PASS" means the parallel FAIL/ERROR
   * was a flake; still non-PASS means it's a real failure, confirmed
   * isolated.
   */
  isolatedRetry?: {
    verdict: "PASS" | "FAIL" | "ERROR";
    checks: number | null;
    failed: number | null;
    errorMessage?: string;
  };
}

/**
 * Runs one scenario for a group sweep, isolating a thrown exception (e.g.
 * waitForCondition/waitActiveTxPk's fail-hard timeout rejection propagating
 * out of drive()) to THIS scenario's outcome instead of aborting the whole
 * sweep -- bash's per-scenario isolation comes for free from each
 * run-scenario.sh invocation being a separate subprocess; this is the
 * same-process equivalent.
 */
async function runOneForSweep<D>(
  spec: ScenarioSpec<D>,
  cpId: string,
): Promise<ScenarioOutcome> {
  try {
    const rec = await runScenario(spec, { cpId });
    return {
      templateId: spec.templateId,
      cpId,
      verdict: rec.verdict,
      checks: rec.total,
      failed: rec.failed,
    };
  } catch (err) {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(
      `[runner] ERROR: ${spec.templateId} on ${cpId} threw before completing: ${message}\n`,
    );
    return {
      templateId: spec.templateId,
      cpId,
      verdict: "ERROR",
      checks: null,
      failed: null,
      errorMessage: message,
    };
  }
}

/**
 * --retry-failed-isolated (issue #184 Finding 4 safety net): re-runs every
 * non-PASS outcome from a --parallel sweep ONE more time, sequentially --
 * one scenario at a time, no concurrent lane -- and records the second
 * verdict on the SAME outcome object as `isolatedRetry`, mutating
 * `outcomes` in place.
 *
 * Why this exists instead of fixing lane isolation outright: juherr's
 * independent SteVe pre-prod run hit 5 parallel-only false-negative FAILs
 * (tc021/tc043-3/tc043-5/reservation-basic/tc054) that all PASSED run in
 * isolation. Investigation here (see README's "Parallel lane isolation"
 * section) found the TS runner's cookie jar is already per-SteveUiOps
 * instance (a fresh `new SteveUiOps()` per runScenario() call, one per
 * lane -- see steve.ts), and concurrent admin sessions were confirmed live
 * not to invalidate each other, so cross-lane session/CSRF contamination is
 * NOT the cause. All 5 flaky scenarios instead share one shape: a
 * SteVe-initiated async CSMS push (steve.op()) whose assert() reads a wire
 * log frozen after a FIXED `holdSecs` sleep (same runScenario() code path
 * already documented above as racy for bootWaitSecs under 3-way parallel
 * docker+JVM host contention). Under --parallel this fixed budget can run
 * out before SteVe's push actually reaches the CP, producing a false FAIL
 * that disappears with no contention. This function does not fix that
 * timing race -- it gives the sweep a way to distinguish a flake from a
 * real failure without giving up --parallel's wall-clock win.
 *
 * Task 2 note: the default driver is now SteveApiOps (steve-api.ts),
 * which holds no cookie/CSRF state at all (stateless Basic auth per
 * request) -- strictly less shared state than SteveUiOps's already-cleared
 * cookie-jar theory above, so it cannot be a NEW source of cross-lane
 * contamination. Whether it changes the actual flake rate is a
 * `--parallel` question this task didn't re-run (Task 2's live proof was
 * 3 single scenarios + 1 UI-fallback single scenario, not a full sweep) --
 * left for Task 4's full-verification pass to confirm or refute.
 */
async function retryFailedOutcomesIsolated(
  outcomes: ScenarioOutcome[],
): Promise<void> {
  const toRetry = outcomes.filter((o) => o.verdict !== "PASS");
  if (toRetry.length === 0) {
    process.stderr.write(
      "[runner] --retry-failed-isolated: no non-PASS outcomes from the parallel sweep -- nothing to retry.\n",
    );
    return;
  }

  process.stderr.write(
    `[runner] --retry-failed-isolated: re-running ${toRetry.length} non-PASS outcome(s) sequentially, isolated from every other lane...\n`,
  );

  for (const outcome of toRetry) {
    const spec = SPECS_BY_TEMPLATE_ID.get(outcome.templateId);
    if (!spec) {
      // Should be unreachable (outcome.templateId always comes from a spec
      // in SPECS_BY_TEMPLATE_ID), but fail soft rather than crash the whole
      // sweep's reporting over a lookup that can't happen in practice.
      process.stderr.write(
        `[runner] WARN: --retry-failed-isolated: no spec found for ${outcome.templateId}, skipping retry\n`,
      );
      continue;
    }
    process.stderr.write(
      `[runner] isolated retry: ${outcome.templateId} on ${outcome.cpId} (parallel verdict was ${outcome.verdict})\n`,
    );
    const retryOutcome = await runOneForSweep(spec, outcome.cpId);
    outcome.isolatedRetry = {
      verdict: retryOutcome.verdict,
      checks: retryOutcome.checks,
      failed: retryOutcome.failed,
      errorMessage: retryOutcome.errorMessage,
    };
    const flake = retryOutcome.verdict === "PASS";
    process.stderr.write(
      `[runner] isolated retry result: ${outcome.templateId} ${retryOutcome.verdict}` +
        (flake
          ? " -- FLAKE (parallel-only false negative, isolated PASS)\n"
          : " -- CONFIRMED (fails isolated too, not a parallel-lane artifact)\n"),
    );
  }
}

function timestampUtc(): string {
  // date -u +%FT%TZ equivalent: ISO-8601 down to the second, "Z" suffix
  // (toISOString() always yields millisecond precision + "Z"; drop the
  // milliseconds to match).
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Renders + writes results/summary.md -- SAME columns/format as
 *  run-all.sh's summary table, so existing docs/screenshots stay truthful.
 *  When any outcome carries an `isolatedRetry` (--retry-failed-isolated ran),
 *  an extra "isolated retry" column and a flake-count note are added; a
 *  sweep with no retries produces the original table unchanged. */
async function writeSummary(
  groupName: string,
  outcomes: ScenarioOutcome[],
): Promise<string> {
  const anyRetried = outcomes.some((o) => o.isolatedRetry !== undefined);

  const rows = outcomes.map((o) => {
    const checks = o.checks === null ? "-" : String(o.checks);
    const failed = o.failed === null ? "-" : String(o.failed);
    const base = `| ${o.templateId} | ${o.cpId} | ${o.verdict} | ${checks} | ${failed} |`;
    if (!anyRetried) return base;
    if (!o.isolatedRetry) return `${base} - |`;
    const flake = o.isolatedRetry.verdict === "PASS";
    const label = `${o.isolatedRetry.verdict}${flake ? " (flake)" : " (confirmed)"}`;
    return `${base} ${label} |`;
  });

  const header = anyRetried
    ? "| scenario | cp | verdict | checks | failed | isolated retry |"
    : "| scenario | cp | verdict | checks | failed |";
  const separator = anyRetried
    ? "| --- | --- | --- | --- | --- | --- |"
    : "| --- | --- | --- | --- | --- |";

  const notes: string[] = [];
  if (anyRetried) {
    const flakeCount = outcomes.filter(
      (o) => o.isolatedRetry?.verdict === "PASS",
    ).length;
    const confirmedCount = outcomes.filter(
      (o) =>
        o.isolatedRetry !== undefined && o.isolatedRetry.verdict !== "PASS",
    ).length;
    notes.push(
      "",
      `--retry-failed-isolated: ${flakeCount} flake(s) (parallel FAIL/ERROR, isolated PASS), ` +
        `${confirmedCount} confirmed failure(s) (fails isolated too).`,
      "Sequential (`run-all` without `--parallel`) remains the reliable reporting " +
        "mode until parallel-lane isolation is guaranteed -- see README's " +
        '"Parallel lane isolation" section.',
    );
  }

  const content =
    [
      `# SteVe verification results — group: ${groupName}`,
      "",
      `Run at ${timestampUtc()}.`,
      "",
      header,
      separator,
      ...rows,
      ...notes,
    ].join("\n") + "\n";

  mkdirSync(RESULTS_DIR, { recursive: true });
  const summaryPath = `${RESULTS_DIR}summary.md`;
  await Bun.write(summaryPath, content);
  return summaryPath;
}

/** Sequential or parallel group sweep. Writes results/summary.md and exits
 *  the process (non-zero if any scenario FAILed or errored, after
 *  accounting for --retry-failed-isolated flakes -- see below). */
async function runGroupSweep(
  groupName: string,
  parallel: boolean,
  retryFailedIsolated: boolean,
): Promise<never> {
  const specs = GROUPS[groupName];
  if (!specs) {
    process.stderr.write(
      `Unknown group: ${groupName} (known: ${Object.keys(GROUPS).join(", ")})\n`,
    );
    process.exit(1);
  }

  process.stderr.write(
    `[runner] group '${groupName}': ${specs.length} scenario(s), parallel=${parallel ? 1 : 0}\n`,
  );

  const cpFor = specs.map((_, i) => GROUP_CPS[i % GROUP_CPS.length]);
  const outcomes: ScenarioOutcome[] = [];

  if (parallel) {
    // Up to 3 concurrent, one per CP -- batch scenarios in groups of 3,
    // mirroring run-all.sh's `batch=(); ...; if [ "${#batch[@]}" -eq 3 ]`
    // loop (a final partial batch, if any, still runs concurrently as its
    // own smaller batch).
    for (let start = 0; start < specs.length; start += GROUP_CPS.length) {
      const batchSpecs = specs.slice(start, start + GROUP_CPS.length);
      const batchCps = cpFor.slice(start, start + GROUP_CPS.length);
      const batchOutcomes = await Promise.all(
        batchSpecs.map((spec, idx) => runOneForSweep(spec, batchCps[idx])),
      );
      outcomes.push(...batchOutcomes);
    }
    // Issue #184 Finding 4: parallel lanes are not fully isolated from each
    // other (host CPU/JVM/docker contention can push a SteVe-initiated
    // async push past a scenario's fixed holdSecs wire-log window -- see
    // retryFailedOutcomesIsolated()'s docstring). Sequential is the only
    // reporting mode proven not to produce that class of false negative;
    // until lane isolation is guaranteed, treat a --parallel FAIL/ERROR as
    // provisional, not final.
    process.stderr.write(
      "[runner] NOTE: --parallel lanes are not fully isolated (issue #184 " +
        "Finding 4) -- a FAIL/ERROR here may be a parallel-only false " +
        "negative. Sequential (no --parallel) remains the reliable " +
        "reporting mode; pass --retry-failed-isolated for a same-run " +
        "safety net.\n",
    );
  } else {
    for (let i = 0; i < specs.length; i++) {
      outcomes.push(await runOneForSweep(specs[i], cpFor[i]));
    }
  }

  if (retryFailedIsolated) {
    if (parallel) {
      await retryFailedOutcomesIsolated(outcomes);
    } else {
      process.stderr.write(
        "[runner] --retry-failed-isolated has no effect without --parallel " +
          "(a sequential sweep is already isolated).\n",
      );
    }
  }

  process.stderr.write(`\n[runner] group '${groupName}' results:\n`);
  for (const o of outcomes) {
    const retrySuffix = o.isolatedRetry
      ? ` [isolated retry: ${o.isolatedRetry.verdict}${
          o.isolatedRetry.verdict === "PASS" ? " -- flake" : " -- confirmed"
        }]`
      : "";
    process.stderr.write(
      `  ${o.verdict}: ${o.templateId} (${o.cpId}, ${o.checks ?? "-"} checks, ${o.failed ?? "-"} failed)${retrySuffix}\n`,
    );
  }

  const summaryPath = await writeSummary(groupName, outcomes);
  process.stderr.write(`[runner] results table: ${summaryPath}\n`);

  // A parallel-lane FAIL/ERROR that PASSed on its isolated retry is a flake
  // (issue #184 Finding 4), not a real failure -- it does not fail the
  // sweep. Anything else non-PASS (no retry attempted, or still non-PASS
  // isolated) counts as a real failure.
  const badOutcomes = outcomes.filter(
    (o) => o.verdict !== "PASS" && o.isolatedRetry?.verdict !== "PASS",
  );
  const flakeCount = outcomes.filter(
    (o) => o.verdict !== "PASS" && o.isolatedRetry?.verdict === "PASS",
  ).length;
  if (flakeCount > 0) {
    process.stderr.write(
      `[runner] ${flakeCount} parallel-only flake(s) in group '${groupName}' (PASSed on isolated retry) -- see ${summaryPath}\n`,
    );
  }
  if (badOutcomes.length > 0) {
    process.stderr.write(
      `[runner] ${badOutcomes.length}/${outcomes.length} scenario(s) in group '${groupName}' FAILed or errored -- see ${summaryPath}\n`,
    );
    process.exit(1);
  }
  process.stderr.write(
    `[runner] all ${outcomes.length} scenario(s) in group '${groupName}' PASSed` +
      (flakeCount > 0
        ? ` (${flakeCount} flake(s) resolved by isolated retry).\n`
        : ".\n"),
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  templateId?: string;
  group?: string;
  runAll: boolean;
  parallel: boolean;
  retryFailedIsolated: boolean;
  cpId: string;
  connector?: number;
  timeoutSecs?: number;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    process.stderr.write(`Error: ${flag} requires a value\n`);
    process.exit(1);
  }
  return value;
}

function requireNumber(argv: string[], index: number, flag: string): number {
  const raw = requireValue(argv, index, flag);
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    process.stderr.write(`Error: ${flag} expects a number, got "${raw}"\n`);
    process.exit(1);
  }
  return n;
}

function printUsage(): void {
  process.stderr.write(
    "Usage (paths shown from the repo root; from scripts/steve-verify " +
      "use the shorter `bun runner/main.ts …`):\n" +
      "       bun scripts/steve-verify/runner/main.ts run <template-id> " +
      "[--cp CERTCP1] [--timeout N] [--connector N]\n" +
      "       bun scripts/steve-verify/runner/main.ts run --group " +
      `${Object.keys(GROUPS).join("|")} [--parallel] [--retry-failed-isolated]\n` +
      "       bun scripts/steve-verify/runner/main.ts run-all " +
      "[--group <name>] [--parallel] [--retry-failed-isolated]\n" +
      "\n" +
      "--retry-failed-isolated: after a --parallel sweep, re-run any " +
      "non-PASS scenario once more, sequentially and isolated, and report " +
      "both verdicts (parallel-fail -> isolated-pass = flake; still fails " +
      "isolated = real fail). No effect without --parallel.\n",
  );
}

function parseArgs(argv: string[]): CliArgs {
  if (argv[0] !== "run" && argv[0] !== "run-all") {
    printUsage();
    process.exit(1);
  }

  let templateId: string | undefined;
  let group: string | undefined;
  let parallel = false;
  let retryFailedIsolated = false;
  let cpId = process.env.DEFAULT_CP_ID ?? "CERTCP1";
  let connector: number | undefined;
  let timeoutSecs: number | undefined;

  if (argv[0] === "run-all") {
    group = "all";
    for (let i = 1; i < argv.length; i++) {
      switch (argv[i]) {
        case "--group":
          group = requireValue(argv, ++i, "--group");
          break;
        case "--parallel":
          parallel = true;
          break;
        case "--retry-failed-isolated":
          retryFailedIsolated = true;
          break;
        default:
          process.stderr.write(`Unknown argument: ${argv[i]}\n`);
          printUsage();
          process.exit(1);
      }
    }
    return { group, runAll: true, parallel, retryFailedIsolated, cpId };
  }

  // argv[0] === "run"
  if (!argv[1]) {
    printUsage();
    process.exit(1);
  }

  let startIndex: number;
  if (argv[1] === "--group") {
    group = requireValue(argv, 2, "--group");
    startIndex = 3;
  } else {
    templateId = argv[1];
    startIndex = 2;
  }

  for (let i = startIndex; i < argv.length; i++) {
    switch (argv[i]) {
      case "--cp":
        cpId = requireValue(argv, ++i, "--cp");
        break;
      case "--connector":
        connector = requireNumber(argv, ++i, "--connector");
        break;
      case "--timeout":
        timeoutSecs = requireNumber(argv, ++i, "--timeout");
        break;
      case "--parallel":
        parallel = true;
        break;
      case "--retry-failed-isolated":
        retryFailedIsolated = true;
        break;
      default:
        process.stderr.write(`Unknown argument: ${argv[i]}\n`);
        printUsage();
        process.exit(1);
    }
  }
  return {
    templateId,
    group,
    runAll: false,
    parallel,
    retryFailedIsolated,
    cpId,
    connector,
    timeoutSecs,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.runAll || args.group !== undefined) {
    await runGroupSweep(
      args.group ?? "all",
      args.parallel,
      args.retryFailedIsolated,
    );
    return;
  }

  const options: RunOptions = {
    cpId: args.cpId,
    connector: args.connector,
    timeoutSecs: args.timeoutSecs,
  };

  if (!args.templateId) {
    printUsage();
    process.exit(1);
  }

  const spec = SPECS_BY_TEMPLATE_ID.get(args.templateId);
  if (!spec) {
    process.stderr.write(
      `Unknown template id: ${args.templateId} (known: ${[...SPECS_BY_TEMPLATE_ID.keys()].join(", ")})\n`,
    );
    process.exit(1);
  }

  const rec = await runScenario(spec, options);
  process.exit(rec.verdict === "PASS" ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(
      `Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
