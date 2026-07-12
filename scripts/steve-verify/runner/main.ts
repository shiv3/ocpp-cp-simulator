#!/usr/bin/env bun
/**
 * main.ts -- TypeScript steve-verify runner CLI (Task 1 slice).
 *
 * Usage: bun scripts/steve-verify/runner/main.ts run <template-id> \
 *          [--cp CERTCP1] [--timeout N] [--connector N]
 *
 * Brings its own simulator container up (sim.ts, mirrors lib.sh's
 * sim_start), drives it over the JSON-Lines stdin protocol, captures its
 * full stdout, parses OCPP-J frames (ocpp.ts) and runs the named spec's
 * drive()/assert() against a live SteVe instance (steve.ts). Task 1 wires
 * exactly the two scenarios needed for the end-to-end proof; Task 2 grows
 * a specs/ directory + `run --group` on top of this same runScenario()
 * core.
 */

import { fileURLToPath } from "node:url";
import {
  AssertRecorder,
  assertEq,
  assertLineMatches,
  assertNoLineMatches,
  assertNotSent,
  assertReceived,
  assertResponseStatus,
  assertSent,
} from "./assert";
import { parseLog } from "./ocpp";
import { defaultSimConfig, startSim } from "./sim";
import { defaultSteveConfig, SteveClient, SteveDb } from "./steve";
import type { AssertContext, DriveContext, ScenarioSpec } from "./spec-types";

// scripts/steve-verify/runner/main.ts is 3 directories below the repo root.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Scenario specs (Task 1: exactly the two needed for the live end-to-end
// proof; Task 2 replaces this with a specs/ directory + registry).
// ---------------------------------------------------------------------------

/** cert16-tc001-cold-boot -- CP-only scenario, no CSMS-side operator action. */
const tc001ColdBootSpec: ScenarioSpec<void> = {
  templateId: "cert16-tc001-cold-boot",
  description:
    "TC_001 Cold Boot: CP re-affirms StatusNotification(Available) after boot, then idles.",
  connector: 1,
  bootWaitSecs: 4,
  holdSecs: 15,
  assert({ frames, lines, rec }: AssertContext<void>) {
    assertSent(rec, frames, "BootNotification", "BootNotification.req sent");
    assertResponseStatus(
      rec,
      frames,
      "BootNotification",
      "Accepted",
      "BootNotification accepted",
      { direction: "sent" },
    );

    const sentAvailableOnConnector1 = frames.some(
      (f) =>
        f.kind === "call" &&
        f.direction === "sent" &&
        f.action === "StatusNotification" &&
        (f.payload as { connectorId?: number; status?: string } | null)
          ?.connectorId === 1 &&
        (f.payload as { connectorId?: number; status?: string } | null)
          ?.status === "Available",
    );
    if (sentAvailableOnConnector1) {
      rec.pass("StatusNotification(Available) sent for connector 1");
    } else {
      rec.fail(
        "StatusNotification(Available) sent for connector 1",
        "no Sent StatusNotification frame with connectorId=1, status=Available",
      );
    }

    // Scenario lifecycle: prefer the structured JSON event
    // ({"event":"scenario_completed",...}) over grepping the free-text
    // "Scenario execution completed" log line -- see the Task 1
    // investigation notes (.superpowers/sdd/tsr-task-1-report.md) for why
    // it's the more robust of the two for lifecycle checks specifically.
    assertLineMatches(
      rec,
      lines,
      /"event":"scenario_completed"/,
      "scenario ran to completion",
    );
    assertNoLineMatches(
      rec,
      lines,
      /blocked by the boot gate/,
      "no messages were dropped by the boot gate",
    );
  },
};

interface RemoteStartRejectedDriveState {
  baselineTxPk: string;
}

/**
 * cert16-tc026-remote-start-rejected -- scenario arms a responseOverride
 * (RemoteStartTransaction -> Rejected) before parking on the trigger; the
 * CSMS sends RemoteStartTransaction on an Available connector and must see
 * Rejected with no StartTransaction/transaction row created.
 */
const tc026RemoteStartRejectedSpec: ScenarioSpec<RemoteStartRejectedDriveState> =
  {
    templateId: "cert16-tc026-remote-start-rejected",
    description:
      "TC_026 Remote Start — Rejected: CSMS RemoteStartTransaction must be Rejected, no transaction created.",
    connector: 1,
    bootWaitSecs: 4,
    holdSecs: 15,
    async drive({
      cpId,
      db,
      steve,
    }: DriveContext): Promise<RemoteStartRejectedDriveState> {
      const baselineTxPk = await db.latestTxPk(cpId);
      // Give the scenario time to arm its responseOverride and park on the
      // csmsCallTrigger node before we fire the operation -- mirrors the
      // bash spec's `sleep 2`.
      await sleep(2000);
      try {
        await steve.op("v1.6/RemoteStartTransaction", {
          chargePointSelectList: steve.cpSelect(cpId),
          connectorId: "1",
          idTag: "CERT-TAG-1",
          chargingProfilePk: "",
        });
      } catch (err) {
        // Mirror the bash spec's `|| true`: a failed queue POST doesn't
        // abort drive() -- assert() below fails loudly on its own if the
        // request never reached the CP.
        process.stderr.write(
          `[runner] WARN: steve_op RemoteStartTransaction failed (continuing): ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
      return { baselineTxPk };
    },
    async assert({
      cpId,
      frames,
      rec,
      db,
      driveState,
    }: AssertContext<RemoteStartRejectedDriveState>) {
      assertReceived(
        rec,
        frames,
        "RemoteStartTransaction",
        "RemoteStartTransaction.req received",
      );
      // uniqueId-correlated: pairs THIS RemoteStartTransaction CALL to ITS
      // OWN CALLRESULT by OCPP-J uniqueId, not the next "Sent: [3,...]"
      // line in the log -- see ocpp.ts's findResponseFor.
      assertResponseStatus(
        rec,
        frames,
        "RemoteStartTransaction",
        "Rejected",
        "RemoteStartTransaction rejected",
        { direction: "received" },
      );
      assertNotSent(
        rec,
        frames,
        "StartTransaction",
        "sent",
        "no StartTransaction sent",
      );

      const after = await db.latestTxPk(cpId);
      assertEq(
        rec,
        after,
        driveState.baselineTxPk,
        `DB: no new transaction row created for ${cpId}`,
      );
    },
  };

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
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  templateId: string;
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

function printUsage(): void {
  process.stderr.write(
    "Usage: bun scripts/steve-verify/runner/main.ts run <template-id> " +
      "[--cp CERTCP1] [--timeout N] [--connector N]\n",
  );
}

function parseArgs(argv: string[]): CliArgs {
  if (argv[0] !== "run" || !argv[1]) {
    printUsage();
    process.exit(1);
  }
  const templateId = argv[1];
  let cpId = process.env.DEFAULT_CP_ID ?? "CERTCP1";
  let connector: number | undefined;
  let timeoutSecs: number | undefined;

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--cp":
        cpId = requireValue(argv, ++i, "--cp");
        break;
      case "--connector":
        connector = Number(requireValue(argv, ++i, "--connector"));
        break;
      case "--timeout":
        timeoutSecs = Number(requireValue(argv, ++i, "--timeout"));
        break;
      default:
        process.stderr.write(`Unknown argument: ${argv[i]}\n`);
        printUsage();
        process.exit(1);
    }
  }
  return { templateId, cpId, connector, timeoutSecs };
}

const KNOWN_SPECS = [tc001ColdBootSpec, tc026RemoteStartRejectedSpec];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const options: RunOptions = {
    cpId: args.cpId,
    connector: args.connector,
    timeoutSecs: args.timeoutSecs,
  };

  let rec: AssertRecorder;
  switch (args.templateId) {
    case tc001ColdBootSpec.templateId:
      rec = await runScenario(tc001ColdBootSpec, options);
      break;
    case tc026RemoteStartRejectedSpec.templateId:
      rec = await runScenario(tc026RemoteStartRejectedSpec, options);
      break;
    default:
      process.stderr.write(
        `Unknown template id: ${args.templateId} (known: ${KNOWN_SPECS.map((s) => s.templateId).join(", ")})\n`,
      );
      process.exit(1);
  }

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
