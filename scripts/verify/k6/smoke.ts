// End-to-end smoke of `export-k6` on a real k6 (#1126): exports a bundled
// scenario, runs it against the mock CSMS (scripts/verify/fakeCsms16.ts) and
// asserts what arrived. With --segments 2 it runs two k6 instances with
// complementary execution segments of one test and asserts that their charger
// ids never overlap (the k6 operator's `parallelism` does exactly this).
//
//   bun scripts/verify/k6/smoke.ts --k6 /path/to/k6 [--chargers 10]
//     [--chargers-per-vu 5] [--segments 1|2] [--scenario <file>] [--keep]
//
// Exit code 0 when every assertion holds. Takes ~15 s.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFakeCsms } from "../fakeCsms16";

const repoRoot = resolve(import.meta.dir, "../../..");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const k6 = arg("--k6", "k6")!;
const chargers = Number(arg("--chargers", "10"));
const perVu = Number(arg("--chargers-per-vu", "5"));
const segments = Number(arg("--segments", "1"));
const scenario = resolve(
  repoRoot,
  arg("--scenario", "scripts/verify/k6/quick-charging-cycle.json")!,
);
const keep = process.argv.includes("--keep");

const failures: string[] = [];
function expect(ok: boolean, what: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

async function run(
  cmd: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    cwd: repoRoot,
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: out + err };
}

const work = mkdtempSync(join(tmpdir(), "k6-smoke-"));
const csms = startFakeCsms({ port: 0, keepFrames: false });
try {
  const exportDir = join(work, "export");
  const exported = await run([
    "bun",
    "apps/cli/src/main.ts",
    "export-k6",
    "--scenario",
    scenario,
    "-o",
    exportDir,
    "--chargers-per-vu",
    String(perVu),
  ]);
  expect(
    exported.code === 0,
    `export-k6 exits 0 (${exported.out.trim().split("\n")[0]})`,
  );
  if (exported.code !== 0) throw new Error(exported.out);

  const env = {
    CSMS_URL: `ws://127.0.0.1:${csms.port}/ocpp`,
    CHARGERS: String(chargers),
    PROFILE: "once",
    DURATION: "30s",
    RAMP_DURATION: "2s",
    METER_VALUE_SAMPLE_INTERVAL: "2",
  };
  const sequence = Array.from({ length: segments + 1 }, (_, i) =>
    i === 0 ? "0" : i === segments ? "1" : `${i}/${segments}`,
  ).join(",");
  const runs = Array.from({ length: segments }, async (_, i) => {
    const summary = join(work, `summary-${i}.json`);
    const result = await run(
      [
        k6,
        "run",
        "--quiet",
        "--summary-export",
        summary,
        ...(segments > 1
          ? [
              "--execution-segment",
              `${sequence.split(",")[i]}:${sequence.split(",")[i + 1]}`,
              "--execution-segment-sequence",
              sequence,
            ]
          : []),
        join(exportDir, "script.js"),
      ],
      env,
    );
    if (result.code !== 0) console.log(result.out);
    return {
      code: result.code,
      summary: JSON.parse(readFileSync(summary, "utf8")),
    };
  });
  const results = await Promise.all(runs);
  for (const [i, r] of results.entries()) {
    expect(r.code === 0, `k6 instance ${i + 1} exits 0 (thresholds hold)`);
  }

  const count = (action: string): number => csms.counts[action] ?? 0;
  const cycles = results.reduce(
    (sum, r) => sum + (r.summary.metrics.ocpp_scenario_cycles?.count ?? 0),
    0,
  );
  expect(
    csms.seen.size === chargers,
    `${chargers} distinct charger ids connected (saw ${csms.seen.size})`,
  );
  expect(
    [...csms.seen.values()].every((n) => n === 1),
    "no charger id connected twice (segments do not overlap)",
  );
  expect(
    count("BootNotification") === chargers,
    `BootNotification x${chargers} (got ${count("BootNotification")})`,
  );
  expect(
    cycles === chargers,
    `k6 counted ${chargers} completed scenario cycles (got ${cycles})`,
  );
  for (const action of ["Authorize", "StartTransaction", "StopTransaction"]) {
    expect(
      count(action) === chargers,
      `${action} x${chargers} (got ${count(action)})`,
    );
  }
  expect(
    count("MeterValues") >= chargers,
    `MeterValues sent (got ${count("MeterValues")})`,
  );
  const sent = results.reduce(
    (sum, r) => sum + (r.summary.metrics.ocpp_calls?.count ?? 0),
    0,
  );
  const received = Object.values(csms.counts).reduce((a, b) => a + b, 0);
  expect(
    sent === received,
    `k6 frame metrics match the CSMS: ocpp_calls ${sent} = ${received} CALLs received`,
  );
} finally {
  csms.stop();
  if (!keep) rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nk6 export smoke passed");
