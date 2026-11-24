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
import { LOOPBACK, tcpPort } from "@ocpp-cp-simulator/core/test/bunServe";

// This pins the `bun build --target=bun` bundle (`bun run build:cli:bun`),
// the one the Docker image and the desktop sidecar run. The published package
// ships a different file, a Node-and-Bun bundle from `bun run build:cli`
// (#916), which scripts/verify-cli-tarball.sh covers on CI. Both are one file,
// dist-cli/main.js, shipped beside dist/ and nothing else (#578): no src/, no packages/core/schema/, no
// vendor/. Everything the CLI needs at run time must therefore be inside the
// bundle, and every path it derives from its own location must be derived
// from the bundle's, not from apps/cli/src/main.ts's.
//
// Two things used to break under that shape and are pinned here:
// - `resolveBundledDist()` looked for dist/ two levels up from the module
//   (<repo>/src/cli → <repo>/dist); the bundle sits one level down.
// - `export-k6` copied its k6 runtime from files beside the module, which the
//   bundle does not carry; the k6 engine bundle is embedded now
//   (`bun run gen:k6-engine` writes it before the CLI is bundled).
//
// The bundle is built into a directory outside the checkout and run from a
// cwd outside it too, so a lookup that silently falls back to the repository
// cannot pass. Runs under `bun test` (needs Bun.spawn and `bun build`), as
// the sidecar test beside this one does; scripts/verify-cli-tarball.sh covers
// the same ground for the published bundle through an actual `npm pack` +
// install on Node and on Bun (CI job cli-runtimes).

const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));

let root = "";
let bundle = "";
let cwd = "";

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ocpp-cli-bundle-")));
  bundle = join(root, "pkg", "dist-cli", "main.js");
  cwd = join(root, "elsewhere");
  mkdirSync(dirname(bundle), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  // The k6 engine the bundle embeds (`build:cli:bun` runs this first).
  const gen = Bun.spawnSync([process.execPath, "run", "gen:k6-engine"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (gen.exitCode !== 0) {
    throw new Error(`gen:k6-engine failed:\n${gen.stderr.toString()}`);
  }
  // The same command as `bun run build:cli:bun`, with the output redirected.
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--target=bun",
      `--outfile=${bundle}`,
      "apps/cli/src/main.ts",
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

/**
 * A port number for the bundle's daemon, which binds it itself (127.0.0.1) in
 * a child process, so no server of this test can keep it. The probe is bound
 * to loopback, so the kernel picks a number free there and not one a wildcard
 * test server elsewhere in the run still holds.
 */
async function freePort(): Promise<number> {
  const server = Bun.serve({
 port: 0,
 hostname: LOOPBACK, fetch: () => new Response("") });
  const port = tcpPort(server);
  await server.stop(true);
  return port;
}

describe("the CLI bundle runs away from the source tree (#578)", () => {
  it("keeps the bun shebang of the Docker/sidecar bundle", () => {
    expect(readFileSync(bundle, "utf8").startsWith("#!/usr/bin/env bun\n")).toBe(
      true,
    );
  });

  it("prints the usage banner", () => {
    const { exitCode, out } = run(["--help"]);
    expect(out).toContain("Usage: ocpp-cp-sim");
    expect(exitCode).toBe(0);
  });

  it("export-k6 writes the embedded k6 engine", () => {
    const scenario = join(
      repoRoot,
      "scripts/verify/k6/quick-charging-cycle.json",
    );
    const out = join(root, "k6");
    const result = run(["export-k6", "--scenario", scenario, "--out", out]);
    expect(result.out).not.toContain("ENOENT");
    expect(result.exitCode).toBe(0);
    for (const file of ["script.js", "engine.js", "scenario.json"]) {
      expect(existsSync(join(out, file)), file).toBe(true);
    }
    // The embedded engine is the one packages/k6-host builds from the sources.
    const engine = readFileSync(join(out, "engine.js"), "utf8");
    expect(engine.length).toBeGreaterThan(500_000);
    expect(engine).toContain("k6/websockets");
  });

  it(
    "bootstraps a charge point with no node_modules anywhere around it",
    async () => {
      // Creating a charge point is what loads the OCPP validators and the
      // vendored schemas, and the scenario schema: everything the Docker
      // runtime image no longer carries beside the bundle. The CSMS URL is a
      // closed port on purpose; the connection failing is fine.
      expect(existsSync(join(root, "node_modules"))).toBe(false);
      expect(existsSync(join(root, "pkg", "node_modules"))).toBe(false);
      const port = await freePort();
      const proc = Bun.spawn(
        [
          process.execPath,
          bundle,
          "--http-port",
          String(port),
          "--state-db",
          ":memory:",
          "--cp-id",
          "x",
          "--connectors",
          "2",
          "--ws-url",
          "ws://127.0.0.1:9/ocpp/",
        ],
        { cwd, stdout: "pipe", stderr: "pipe" },
      );
      let log = "";
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          log += decoder.decode(value, { stream: true });
        }
      };
      void pump(proc.stdout);
      void pump(proc.stderr);
      try {
        const deadline = Date.now() + 30_000;
        while (
          Date.now() < deadline &&
          !log.includes('Bootstrapped CP "x"') &&
          proc.exitCode === null
        )
          await Bun.sleep(100);
        if (!log.includes('Bootstrapped CP "x"')) console.error(log);
        expect(log).toContain('Bootstrapped CP "x"');
        const health = await fetch(`http://127.0.0.1:${port}/v1/healthz`);
        expect(health.status).toBe(200);
      } finally {
        proc.kill();
        await proc.exited;
      }
    },
    90_000,
  );

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
