// Stage D2, item 2: the web build in a real Chromium.
//
//   bun scripts/verify/browser/run.ts [--hash-chargers 1000] [--hash-hours 1]
//
// 1. bundles the page (LocalChargePointService + the determinism fleet) for the
//    browser and serves it;
// 2. builds the example behavior (`behavior build`) and gives it to the page's
//    file input; the page loads it with import(blobUrl);
// 3. a fake CSMS (real WebSocket) must see the behavior's frames;
// 4. runs the VirtualClock fleet in the page and on Bun and compares hashes.
//
// Needs Playwright, which is not a dependency of this repository:
//   mkdir /tmp/pw && cd /tmp/pw && bun add playwright-core
//   PLAYWRIGHT_MODULE=/tmp/pw/node_modules/playwright-core/index.mjs \
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers bun scripts/verify/browser/run.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildBehaviorFile } from "../../../apps/cli/src/behavior/buildBehavior";
import {
  runFleet,
  sha256Lines,
} from "../../../packages/core/src/cp/shared/__tests__/virtualFleet";
import { startFakeCsms } from "../fakeCsms16";

const here = import.meta.dir;
const repo = path.resolve(here, "../../..");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

interface PwPage {
  goto(url: string): Promise<unknown>;
  waitForFunction(
    fn: string | (() => unknown),
    arg?: unknown,
    o?: { timeout?: number },
  ): Promise<unknown>;
  evaluate<T>(
    fn: string | ((arg: never) => T | Promise<T>),
    arg?: unknown,
  ): Promise<T>;
  setInputFiles(selector: string, file: string): Promise<void>;
  on(event: string, handler: (arg: { text(): string }) => void): void;
}
interface Pw {
  chromium: {
    launch(o: { headless: boolean }): Promise<{
      newPage(): Promise<PwPage>;
      close(): Promise<void>;
    }>;
  };
}

const pwModule = process.env.PLAYWRIGHT_MODULE ?? "playwright-core";
const pw = (await import(pwModule)) as Pw;

const work = mkdtempSync(path.join(tmpdir(), "d2-browser-"));
const built = await Bun.build({
  entrypoints: [path.join(here, "page.ts")],
  outdir: work,
  target: "browser",
  format: "esm",
});
if (!built.success) {
  console.error(built.logs.map((l) => l.message).join("\n"));
  process.exit(1);
}
const html = readFileSync(path.join(here, "index.html"), "utf8");

const bundle = await buildBehaviorFile(
  path.join(repo, "examples/behaviors/flaky-firmware.ts"),
  path.join(work, "flaky.bundle.js"),
);
if (!bundle.ok) {
  console.error(bundle.problems.join("\n"));
  process.exit(1);
}

const web = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/")
      return new Response(html, { headers: { "content-type": "text/html" } });
    const f = Bun.file(path.join(work, p));
    return f.size > 0
      ? new Response(f)
      : new Response("not found", { status: 404 });
  },
});
const csms = startFakeCsms({ port: 0, updateFirmware: true });

const browser = await pw.chromium.launch({ headless: true });
const page = await browser.newPage();
const consoleLines: string[] = [];
page.on("console", (m) => consoleLines.push(m.text()));
page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.text()}`));
await page.goto(`http://127.0.0.1:${web.port}/`);
await page.waitForFunction(
  () => document.getElementById("status")?.textContent === "ready",
);

const out: Record<string, unknown> = {
  env: await page.evaluate(() =>
    (window as unknown as { __d2: { env(): unknown } }).__d2.env(),
  ),
};

// ---- the behavior in the page ------------------------------------------
await page.evaluate(
  ({ wsUrl }) =>
    (
      window as unknown as { __d2: { setup(o: unknown): Promise<void> } }
    ).__d2.setup({
      wsUrl,
      cpId: "CP-BROWSER",
    }),
  { wsUrl: `ws://127.0.0.1:${csms.port}/CP-BROWSER` } as never,
);
await page.setInputFiles("#bundle", bundle.outFile as string);
await page.waitForFunction(() =>
  /^(loaded|error)/.test(document.getElementById("status")?.textContent ?? ""),
);
out.pageState = await page.evaluate(() =>
  (window as unknown as { __d2: { state(): unknown } }).__d2.state(),
);
await page.evaluate(() =>
  (window as unknown as { __d2: { connect(): Promise<void> } }).__d2.connect(),
);
const deadline = Date.now() + 30_000;
const seen = (): string[] =>
  csms.frames
    .filter((f) => f.dir === "in" && Array.isArray(f.frame) && f.frame[0] === 2)
    .map((f) => {
      const frame = f.frame as unknown[];
      const payload = frame[3] as { status?: string };
      return frame[2] === "FirmwareStatusNotification"
        ? `${frame[2]}:${payload.status}`
        : String(frame[2]);
    });
while (
  Date.now() < deadline &&
  !seen().some((s) => /Installed|InstallationFailed/.test(s))
) {
  await Bun.sleep(200);
}
out.csmsSaw = seen();
out.csmsFrameCount = csms.frames.length;

// ---- determinism: browser vs Bun ----------------------------------------
const chargers = Number(arg("--hash-chargers", "25"));
const hours = Number(arg("--hash-hours", "1"));
const seed = arg("--hash-seed", "pinned");
const browserRun = await page.evaluate(
  ({ seed, chargers, hours }) =>
    (
      window as unknown as {
        __d2: { fleet(s: string, c: number, h: number): Promise<unknown> };
      }
    ).__d2.fleet(seed, chargers, hours),
  { seed, chargers, hours } as never,
);
const bunStart = performance.now();
const bunRun = await runFleet(seed, chargers, hours);
const bunHash = await sha256Lines(bunRun.all);
out.fleet = {
  seed,
  chargers,
  hours,
  browser: browserRun,
  bun: {
    hash: bunHash,
    effects: bunRun.all.length,
    timers: bunRun.timers,
    realMs: performance.now() - bunStart,
  },
  agree: (browserRun as { hash: string }).hash === bunHash,
};
out.console = consoleLines.slice(0, 20);
console.log(JSON.stringify(out, null, 2));

await browser.close();
csms.stop();
web.stop(true);
process.exit((out.fleet as { agree: boolean }).agree ? 0 : 2);
