// export-k6 --behavior: what it writes, and what it refuses (Bun: the export
// bundles the behavior with Bun.build).
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dir, "../../../../..");
const main = path.join(repo, "apps/cli/src/main.ts");
const fixtures = path.join(import.meta.dir, "behaviors");
const example = path.join(repo, "examples/behaviors/flaky-firmware.ts");

async function exportK6(...args: string[]) {
  const out = mkdtempSync(path.join(tmpdir(), "export-k6-behavior-"));
  const proc = Bun.spawn(
    ["bun", main, "export-k6", ...args, "-o", path.join(out, "x")],
    { stdout: "pipe", stderr: "pipe", cwd: repo },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr, dir: path.join(out, "x") };
}

describe("export-k6 --behavior", () => {
  it("writes the runtime, the bundle and an entry that imports it statically", async () => {
    const r = await exportK6("--behavior", example);
    expect(r.code).toBe(0);
    const entry = readFileSync(path.join(r.dir, "behavior.k6.ts"), "utf8");
    expect(entry).toContain(
      'import behavior0 from "./behaviors/01-flaky-firmware.bundle.js";',
    );
    expect(entry).toContain('from "./ocpp-runtime/index.ts"');
    expect(readdirSync(path.join(r.dir, "behaviors"))).toEqual([
      "01-flaky-firmware.bundle.js",
    ]);
    for (const f of ["behaviorHost.ts", "behaviorRun.ts", "index.ts"]) {
      expect(existsSync(path.join(r.dir, "ocpp-runtime", f))).toBe(true);
    }
    const bundle = readFileSync(
      path.join(r.dir, "behaviors/01-flaky-firmware.bundle.js"),
      "utf8",
    );
    expect(bundle).not.toMatch(/from "k6/);
    // ctx.sleep is a timer of the host: no file of the runtime imports k6's
    // sleep().
    for (const f of readdirSync(path.join(r.dir, "ocpp-runtime"))) {
      if (!f.endsWith(".ts")) continue;
      const text = readFileSync(path.join(r.dir, "ocpp-runtime", f), "utf8");
      expect(text).not.toMatch(
        /import\s*\{[^}]*\bsleep\b[^}]*\}\s*from\s*"k6"/,
      );
    }
  });

  it("refuses a requirement the k6 host cannot meet", async () => {
    for (const [file, need] of [
      ["needsPhysical.ts", "physical"],
      ["needsVersion2.ts", "ocpp2.x"],
    ] as const) {
      const r = await exportK6("--behavior", path.join(fixtures, file));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`requires "${need}"`);
      expect(existsSync(r.dir)).toBe(false);
    }
  });

  it("refuses an extend rule", async () => {
    const r = await exportK6(
      "--behavior",
      path.join(fixtures, "extendMode.ts"),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('mode "extend"');
    expect(r.stderr).toContain("ctx.defaultBehavior");
  });

  it("refuses the connector and transaction hooks, never ignoring them", async () => {
    const r = await exportK6(
      "--behavior",
      path.join(fixtures, "usesConnectorHook.ts"),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("on.connectorStatus");
    expect(r.stderr).toContain("on.transactionStarted");
    expect(existsSync(r.dir)).toBe(false);
  });

  it("exports the call hooks, beforeSend and ctx.accepted, with the canned answers", async () => {
    const r = await exportK6(
      "--behavior",
      path.join(fixtures, "usesCallHooks.ts"),
    );
    expect(r.code).toBe(0);
    const entry = readFileSync(path.join(r.dir, "behavior.k6.ts"), "utf8");
    expect(entry).toContain('"UpdateFirmware":{"accepted":{}}');
    expect(entry).toContain('"Reset":{"accepted":{"status":"Accepted"}');
  });

  it("refuses unsupported ctx members, also destructured", async () => {
    const plug = await exportK6(
      "--behavior",
      path.join(fixtures, "usesPlugIn.ts"),
    );
    expect(plug.code).toBe(1);
    expect(plug.stderr).toContain("ctx.plugIn");
    const conn = await exportK6(
      "--behavior",
      path.join(fixtures, "usesConnector.ts"),
    );
    expect(conn.code).toBe(1);
    expect(conn.stderr).toContain("ctx.connector");
  });

  it("is exclusive with --scenario and needs one of them", async () => {
    const both = await exportK6("--behavior", example, "--scenario", "s.json");
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("exclusive");
  });

  it("refuses a file that does not exist", async () => {
    const r = await exportK6("--behavior", path.join(fixtures, "nope.ts"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No such file");
  });
});
