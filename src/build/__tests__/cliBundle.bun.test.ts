import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tcpPort } from "../../test/bunServe";

// The published CLI is one `bun build --target=bun` file, dist-cli/main.js,
// shipped beside dist/ and nothing else (#578): no src/, no schema/, no
// vendor/. Everything the CLI needs at run time must therefore be inside the
// bundle, and every path it derives from its own location must be derived
// from the bundle's, not from src/cli/main.ts's.
//
// Two things used to break under that shape and are pinned here:
// - `resolveBundledDist()` looked for dist/ two levels up from the module
//   (<repo>/src/cli → <repo>/dist); the bundle sits one level down.
// - `export-k6` copied its k6 runtime from src/cli/exportK6/runtime/ beside
//   the module, which the bundle does not carry; it is embedded now.
//
// The bundle is built into a directory outside the checkout and run from a
// cwd outside it too, so a lookup that silently falls back to the repository
// cannot pass. Runs under `bun test` (needs Bun.spawn and `bun build`), as
// the sidecar test beside this one does; scripts/verify-cli-tarball.sh covers
// the same ground through an actual `npm pack` + `bun install -g` on CI.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

let root = "";
let bundle = "";
let cwd = "";

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ocpp-cli-bundle-")));
  bundle = join(root, "pkg", "dist-cli", "main.js");
  cwd = join(root, "elsewhere");
  mkdirSync(dirname(bundle), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  // The same command as `bun run build:cli`, with the output redirected.
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--target=bun",
      `--outfile=${bundle}`,
      "src/cli/main.ts",
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) console.error(build.stderr.toString());
  expect(build.exitCode).toBe(0);
}, 180_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function run(args: string[]): { exitCode: number; out: string } {
  const proc = Bun.spawnSync([process.execPath, bundle, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
  };
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = tcpPort(server);
  await server.stop(true);
  return port;
}

describe("the CLI bundle runs away from the source tree (#578)", () => {
  it("keeps the bun shebang, so an installed bin starts without a loader", () => {
    expect(readFileSync(bundle, "utf8").startsWith("#!/usr/bin/env bun\n")).toBe(
      true,
    );
  });

  it("prints the usage banner", () => {
    const { exitCode, out } = run(["--help"]);
    expect(out).toContain("Usage: ocpp-cp-sim");
    expect(exitCode).toBe(0);
  });

  it("export-k6 writes the embedded runtime", () => {
    const scenario = join(
      repoRoot,
      "docs/examples/scenarios/demo-charging.json",
    );
    const out = join(root, "k6");
    const result = run(["export-k6", "--scenario", scenario, "--out", out]);
    expect(result.out).not.toContain("ENOENT");
    expect(result.exitCode).toBe(0);
    for (const file of [
      "scenario.k6.ts",
      "ocpp-runtime/index.ts",
      "ocpp-runtime/curve.ts",
      "ocpp-runtime/wire/v16.ts",
    ]) {
      expect(existsSync(join(out, file)), file).toBe(true);
    }
    // The embedded copy is the repository's runtime, byte for byte.
    expect(readFileSync(join(out, "ocpp-runtime/curve.ts"), "utf8")).toBe(
      readFileSync(join(repoRoot, "src/cli/exportK6/runtime/curve.ts"), "utf8"),
    );
  });

  it(
    "--web-console finds <pkg>/dist beside <pkg>/dist-cli",
    async () => {
      const dist = join(root, "pkg", "dist");
      mkdirSync(dist, { recursive: true });
      const sentinel = `bundle-console-${Date.now()}`;
      writeFileSync(
        join(dist, "index.html"),
        `<!doctype html><html><body><div id="root">${sentinel}</div></body></html>`,
      );
      // A decoy where the source-checkout rule (two levels up) would look
      // from the bundle: <root>/dist, beside the package. The package's own
      // dist/ must win, so the candidate order matters.
      const decoy = join(root, "dist");
      mkdirSync(decoy, { recursive: true });
      writeFileSync(
        join(decoy, "index.html"),
        `<!doctype html><html><body><div id="root">decoy-above-the-package</div></body></html>`,
      );
      const port = await freePort();
      const proc = Bun.spawn(
        [
          process.execPath,
          bundle,
          "--http-port",
          String(port),
          "--web-console",
          "--state-db",
          ":memory:",
        ],
        { cwd, stdout: "pipe", stderr: "pipe" },
      );
      try {
        const deadline = Date.now() + 30_000;
        let body = "";
        while (Date.now() < deadline) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            if (res.ok) {
              body = await res.text();
              break;
            }
          } catch {
            // not listening yet
          }
          if (proc.exitCode !== null) break;
          await Bun.sleep(200);
        }
        if (!body.includes(sentinel)) {
          console.error(await new Response(proc.stderr).text());
        }
        expect(body).toContain(sentinel);
        expect(body).not.toContain("decoy-above-the-package");
      } finally {
        proc.kill();
        await proc.exited;
      }
    },
    90_000,
  );
});
