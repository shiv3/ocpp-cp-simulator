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
import { defaultSteveConfig, SteveClient, SteveDb } from "./steve";
import {
  AUTHLIST_RESERVATION_SPECS,
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
  const steve = new SteveClient(steveCfg);

  await db.closeStaleTx(options.cpId);

  process.stderr.write(
    `[runner] === ${spec.templateId} on ${options.cpId} (connector ${connector}, boot-wait ${bootWaitSecs}s, hold ${holdSecs}s) ===\n`,
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
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GROUPS: Record<string, ScenarioSpec<any>[]> = {
  core: CORE_SPECS,
  "authlist-reservation": AUTHLIST_RESERVATION_SPECS,
  "remotetrigger-smartcharging": REMOTETRIGGER_SMARTCHARGING_SPECS,
  firmware: FIRMWARE_SPECS,
  // Concatenation order mirrors run-all.sh's `all)` case exactly: CORE +
  // AUTHLIST_RESERVATION + REMOTETRIGGER_SMARTCHARGING + FIRMWARE.
  all: [
    ...CORE_SPECS,
    ...AUTHLIST_RESERVATION_SPECS,
    ...REMOTETRIGGER_SMARTCHARGING_SPECS,
    ...FIRMWARE_SPECS,
  ],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SPECS_BY_TEMPLATE_ID = new Map<string, ScenarioSpec<any>>(
  GROUPS.all.map((spec) => [spec.templateId, spec]),
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

function timestampUtc(): string {
  // date -u +%FT%TZ equivalent: ISO-8601 down to the second, "Z" suffix
  // (toISOString() always yields millisecond precision + "Z"; drop the
  // milliseconds to match).
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Renders + writes results/summary.md -- SAME columns/format as
 *  run-all.sh's summary table, so existing docs/screenshots stay truthful. */
async function writeSummary(
  groupName: string,
  outcomes: ScenarioOutcome[],
): Promise<string> {
  const rows = outcomes.map((o) => {
    const checks = o.checks === null ? "-" : String(o.checks);
    const failed = o.failed === null ? "-" : String(o.failed);
    return `| ${o.templateId} | ${o.cpId} | ${o.verdict} | ${checks} | ${failed} |`;
  });

  const content =
    [
      `# SteVe verification results — group: ${groupName}`,
      "",
      `Run at ${timestampUtc()}.`,
      "",
      "| scenario | cp | verdict | checks | failed |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
    ].join("\n") + "\n";

  mkdirSync(RESULTS_DIR, { recursive: true });
  const summaryPath = `${RESULTS_DIR}summary.md`;
  await Bun.write(summaryPath, content);
  return summaryPath;
}

/** Sequential or parallel group sweep. Writes results/summary.md and exits
 *  the process (non-zero if any scenario FAILed or errored). */
async function runGroupSweep(
  groupName: string,
  parallel: boolean,
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
  } else {
    for (let i = 0; i < specs.length; i++) {
      outcomes.push(await runOneForSweep(specs[i], cpFor[i]));
    }
  }

  process.stderr.write(`\n[runner] group '${groupName}' results:\n`);
  for (const o of outcomes) {
    process.stderr.write(
      `  ${o.verdict}: ${o.templateId} (${o.cpId}, ${o.checks ?? "-"} checks, ${o.failed ?? "-"} failed)\n`,
    );
  }

  const summaryPath = await writeSummary(groupName, outcomes);
  process.stderr.write(`[runner] results table: ${summaryPath}\n`);

  const badCount = outcomes.filter((o) => o.verdict !== "PASS").length;
  if (badCount > 0) {
    process.stderr.write(
      `[runner] ${badCount}/${outcomes.length} scenario(s) in group '${groupName}' FAILed or errored -- see ${summaryPath}\n`,
    );
    process.exit(1);
  }
  process.stderr.write(
    `[runner] all ${outcomes.length} scenario(s) in group '${groupName}' PASSed.\n`,
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
      `${Object.keys(GROUPS).join("|")} [--parallel]\n` +
      "       bun scripts/steve-verify/runner/main.ts run-all " +
      "[--group <name>] [--parallel]\n",
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
        default:
          process.stderr.write(`Unknown argument: ${argv[i]}\n`);
          printUsage();
          process.exit(1);
      }
    }
    return { group, runAll: true, parallel, cpId };
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
    cpId,
    connector,
    timeoutSecs,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.runAll || args.group !== undefined) {
    await runGroupSweep(args.group ?? "all", args.parallel);
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
