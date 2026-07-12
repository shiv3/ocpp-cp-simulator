#!/usr/bin/env bun
/**
 * main.ts -- TypeScript steve-verify runner CLI.
 *
 * Usage: bun scripts/steve-verify/runner/main.ts run <template-id> \
 *          [--cp CERTCP1] [--timeout N] [--connector N]
 *        bun scripts/steve-verify/runner/main.ts run --group core|authlist-reservation
 *
 * Brings its own simulator container up (sim.ts, mirrors lib.sh's
 * sim_start), drives it over the JSON-Lines stdin protocol, captures its
 * full stdout, parses OCPP-J frames (ocpp.ts) and runs the named spec's
 * drive()/assert() against a live SteVe instance (steve.ts). Task 1 wired
 * the runner core + two scenarios directly here; Task 2 grows a specs/
 * directory (typed spec objects per group) + this `run --group` sweep on
 * top of the same runScenario() core -- sequential only, one CP per
 * scenario round-robined across CERTCP1..3 (mirrors run-all.sh's CP_FOR
 * assignment); Task 3 adds --parallel and the remaining groups.
 */

import { fileURLToPath } from "node:url";
import {
  AssertRecorder,
  assertEq,
  assertNotSent,
  assertReceived,
  assertResponseStatus,
} from "./assert";
import { parseLog } from "./ocpp";
import { defaultSimConfig, startSim } from "./sim";
import { defaultSteveConfig, SteveClient, SteveDb } from "./steve";
import { AUTHLIST_RESERVATION_SPECS, CORE_SPECS } from "./specs/index";
import type { AssertContext, DriveContext, ScenarioSpec } from "./spec-types";
import { sleep } from "./util";

// scripts/steve-verify/runner/main.ts is 3 directories below the repo root.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// ---------------------------------------------------------------------------
// Scenario specs -- the Core and LocalAuthList/Reservation groups now live
// in specs/ (Task 2); cert16-tc026-remote-start-rejected is a
// RemoteTrigger/SmartCharging-group scenario (Task 3's group, not yet
// ported into specs/), kept here as the Task 1 proof scenario and merged
// into the combined registry below so `run <template-id>` still finds it.
// ---------------------------------------------------------------------------

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
// Spec registry -- groups mirror run-all.sh's group names exactly (Task 3
// adds remotetrigger-smartcharging/firmware/all on top of this same map).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GROUPS: Record<string, ScenarioSpec<any>[]> = {
  core: CORE_SPECS,
  "authlist-reservation": AUTHLIST_RESERVATION_SPECS,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALL_SPECS: ScenarioSpec<any>[] = [
  ...CORE_SPECS,
  ...AUTHLIST_RESERVATION_SPECS,
  tc026RemoteStartRejectedSpec,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SPECS_BY_TEMPLATE_ID = new Map<string, ScenarioSpec<any>>(
  ALL_SPECS.map((spec) => [spec.templateId, spec]),
);

// Round-robins scenarios across CERTCP1..3 so adjacent scenarios in a group
// sweep don't collide on the same charge point's transaction state --
// mirrors run-all.sh's CP_FOR assignment.
const GROUP_CPS = ["CERTCP1", "CERTCP2", "CERTCP3"];

/** Sequential group sweep (Task 3 adds --parallel). Exits the process. */
async function runGroup(groupName: string): Promise<never> {
  const specs = GROUPS[groupName];
  if (!specs) {
    process.stderr.write(
      `Unknown group: ${groupName} (known: ${Object.keys(GROUPS).join(", ")})\n`,
    );
    process.exit(1);
  }

  process.stderr.write(
    `[runner] group '${groupName}': ${specs.length} scenario(s), sequential\n`,
  );

  const results: { templateId: string; cpId: string; rec: AssertRecorder }[] =
    [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const cpId = GROUP_CPS[i % GROUP_CPS.length];
    const rec = await runScenario(spec, { cpId });
    results.push({ templateId: spec.templateId, cpId, rec });
  }

  process.stderr.write(`\n[runner] group '${groupName}' results:\n`);
  for (const { templateId, cpId, rec } of results) {
    process.stderr.write(
      `  ${rec.verdict}: ${templateId} (${cpId}, ${rec.total} checks, ${rec.failed} failed)\n`,
    );
  }

  const failedCount = results.filter((r) => r.rec.verdict === "FAIL").length;
  if (failedCount > 0) {
    process.stderr.write(
      `[runner] ${failedCount}/${results.length} scenario(s) in group '${groupName}' FAILed\n`,
    );
    process.exit(1);
  }
  process.stderr.write(
    `[runner] all ${results.length} scenario(s) in group '${groupName}' PASSed.\n`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  templateId?: string;
  group?: string;
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
      "[--cp CERTCP1] [--timeout N] [--connector N]\n" +
      "       bun scripts/steve-verify/runner/main.ts run --group " +
      `${Object.keys(GROUPS).join("|")}\n`,
  );
}

function parseArgs(argv: string[]): CliArgs {
  if (argv[0] !== "run" || !argv[1]) {
    printUsage();
    process.exit(1);
  }

  let templateId: string | undefined;
  let group: string | undefined;
  let cpId = process.env.DEFAULT_CP_ID ?? "CERTCP1";
  let connector: number | undefined;
  let timeoutSecs: number | undefined;

  if (argv[1] === "--group") {
    group = requireValue(argv, 2, "--group");
  } else {
    templateId = argv[1];
  }

  const startIndex = group !== undefined ? 3 : 2;
  for (let i = startIndex; i < argv.length; i++) {
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
  return { templateId, group, cpId, connector, timeoutSecs };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.group !== undefined) {
    await runGroup(args.group);
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
