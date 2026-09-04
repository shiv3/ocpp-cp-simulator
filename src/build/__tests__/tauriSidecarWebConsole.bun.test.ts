import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
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

// Regression guard for issue #319 — "the bundled daemon exits(1) on spawn".
//
// `src-tauri/src/lib.rs` spawns the Bun-compiled sidecar with `--web-console`.
// `resolveBundledDist()` used to look for `dist/` relative to
// `import.meta.dir`, which inside a `bun build --compile` binary is the
// in-binary VFS root (`/$bunfs/root`) — so the lookup resolved to `/dist`,
// found nothing, and the daemon exited 1 before binding a port. The splash
// screen polled `/v1/healthz` for 30 s and then rendered "Daemon failed to
// start". Roughly 30 desktop releases (v0.3.2 through v0.7.8) shipped that
// way, because CI built the sidecar but never *ran* it.
//
// So this test runs it. It compiles the CLI the way the release does and
// launches it with the arguments parsed out of `lib.rs` itself — a private
// copy of that list would drift away from the desktop app in exactly the
// same silent fashion. Readiness is judged against `splash.html`'s own
// `POLL_TIMEOUT_MS` / `HEALTH_PATH`, so the assertion is the contract the
// user actually experiences: answer health inside the splash budget and
// serve the console, or fail.
//
// Runs under `bun test` (the `test:bun` script, which `.github/workflows/
// ci.yml` runs on every pull request), NOT vitest: it needs `Bun.spawn` and
// `bun build --compile`.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The exact arguments the desktop shell passes, read from the Rust source.
 *
 * `lib.rs` keeps them in a `DAEMON_ARGS` template of string literals with
 * `{...}` placeholders precisely so this parse stays trivial. If the shape
 * ever changes, the guard assertions below fail loudly rather than letting
 * the test quietly exercise nothing.
 */
function daemonArgTemplate(): string[] {
  const src = readFileSync(join(repoRoot, "src-tauri/src/lib.rs"), "utf8");
  const start = src.indexOf("const DAEMON_ARGS: &[&str] = &[");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("];", start);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start, end);
  return [...block.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]);
}

/** `POLL_TIMEOUT_MS` / `HEALTH_PATH` as `public/splash.html` defines them. */
function splashContract(): { timeoutMs: number; healthPath: string } {
  const html = readFileSync(join(repoRoot, "public/splash.html"), "utf8");
  const timeout = html.match(/POLL_TIMEOUT_MS\s*=\s*([\d_]+)/);
  const health = html.match(/HEALTH_PATH\s*=\s*"([^"]+)"/);
  expect(timeout).not.toBeNull();
  expect(health).not.toBeNull();
  return {
    timeoutMs: Number(timeout![1].replace(/_/g, "")),
    healthPath: health![1],
  };
}

const TEMPLATE = daemonArgTemplate();
const SPLASH = splashContract();

/**
 * Fill in the template the way `daemon_args()` in `lib.rs` does: substitute
 * the runtime values, and when there is no explicit web-console directory
 * drop `--web-console-dist` together with its placeholder (dropping the flag
 * alone would leave a stray positional argument).
 */
function buildArgs(opts: {
  port: number;
  stateDb: string;
  webConsoleDist: string | null;
}): string[] {
  const out: string[] = [];
  for (let i = 0; i < TEMPLATE.length; i++) {
    const arg = TEMPLATE[i];
    if (arg === "--web-console-dist") {
      if (opts.webConsoleDist !== null) {
        out.push(arg, opts.webConsoleDist);
      }
      i++;
      continue;
    }
    if (arg === "{port}") out.push(String(opts.port));
    else if (arg === "{state_db}") out.push(opts.stateDb);
    else out.push(arg);
  }
  return out;
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port;
  await server.stop(true);
  return port;
}

function writeConsole(dir: string, sentinel: string): string {
  mkdirSync(dir, { recursive: true });
  // Synchronous on purpose: the daemon stats index.html moments later, and
  // an un-awaited Bun.write() would make that a race.
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><title>OCPP</title></head><body>${sentinel}</body></html>`,
  );
  return dir;
}

let root = "";
let compiled = "";

/**
 * Compile the CLI exactly as `scripts/build-tauri-sidecar.sh` does (host
 * target; the script only adds `--target` for cross-compiles). This is the
 * only shape that reproduces #319: interpreted runs resolve `dist/` fine.
 */
beforeAll(() => {
  // realpath: on macOS TMPDIR is /var/folders/... but the daemon reports
  // process.execPath resolved to /private/var/..., and the negative case
  // matches the two against each other.
  root = realpathSync(mkdtempSync(join(tmpdir(), "ocpp-sidecar-319-")));
  compiled = join(root, "build", "ocpp-cp-sim");
  mkdirSync(dirname(compiled), { recursive: true });
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      "src/cli/main.ts",
      "--outfile",
      compiled,
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) console.error(build.stderr.toString());
  expect(build.exitCode).toBe(0);
}, 180_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Place a copy of the compiled binary at `path`, executable. */
function installBinary(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(compiled, path);
  chmodSync(path, 0o755);
  return path;
}

interface RunResult {
  readonly ready: boolean;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly body: string;
}

/**
 * Launch the sidecar and reproduce what the splash screen does: poll
 * `HEALTH_PATH` until it answers `{ok:true}` or `POLL_TIMEOUT_MS` elapses.
 * A process that exits early and one that never becomes ready look
 * identical to the user, so both come back with `ready: false`.
 */
async function launch(binary: string, args: string[]): Promise<RunResult> {
  const proc = Bun.spawn([binary, ...args], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
  });
  // Consume stderr as it is produced: an unread pipe can block the child.
  const stderrText = new Response(proc.stderr).text();
  const portIndex = args.indexOf("--http-port");
  const base = `http://127.0.0.1:${args[portIndex + 1]}`;
  const deadline = Date.now() + SPLASH.timeoutMs;
  let ready = false;
  let body = "";
  try {
    while (Date.now() < deadline) {
      // Exited before binding — the #319 symptom. Stop now instead of
      // burning the whole splash budget on a corpse.
      if (proc.exitCode !== null) break;
      try {
        const res = await fetch(`${base}${SPLASH.healthPath}`, {
          cache: "no-store",
        });
        if (res.ok && (await res.json())?.ok === true) {
          ready = true;
          body = await (await fetch(`${base}/`)).text();
          break;
        }
      } catch {
        // not bound yet
      }
      await Bun.sleep(200);
    }
  } finally {
    proc.kill();
    await proc.exited;
  }
  return { ready, exitCode: proc.exitCode, stderr: await stderrText, body };
}

describe("Tauri sidecar serves the web console (#319)", () => {
  it("parses a usable argument template out of lib.rs", () => {
    // Guard the guard: a `lib.rs` refactor that defeated the parse would
    // make every launch below run with an empty argument list, which is
    // "healthy" for none of the right reasons.
    expect(TEMPLATE).toContain("--web-console");
    expect(TEMPLATE).toContain("--http-port");
    expect(TEMPLATE).toContain("{port}");
    expect(TEMPLATE).toContain("--web-console-dist");
    expect(TEMPLATE.length).toBeGreaterThanOrEqual(10);
    expect(SPLASH.healthPath).toBe("/v1/healthz");
    expect(SPLASH.timeoutMs).toBeGreaterThanOrEqual(5_000);
  });

  it(
    "starts and serves the console with the exact arguments lib.rs passes",
    async () => {
      // The desktop bundle's shape: the sidecar has no `dist/` anywhere near
      // it, and the shell hands it the Tauri resource directory.
      const binary = installBinary(join(root, "bundle", "bin", "ocpp-cp-sim"));
      const dist = writeConsole(
        join(root, "bundle", "resources", "web-console"),
        "SENTINEL_RESOURCE_DIR",
      );
      const result = await launch(
        binary,
        buildArgs({
          port: await freePort(),
          stateDb: join(root, "bundle", "state.db"),
          webConsoleDist: dist,
        }),
      );
      if (!result.ready) console.error(result.stderr);
      expect(result.exitCode).not.toBe(1);
      expect(result.ready).toBe(true);
      expect(result.body).toContain("SENTINEL_RESOURCE_DIR");
    },
    SPLASH.timeoutMs + 60_000,
  );

  it(
    "finds a dist/ next to the compiled binary without being told",
    async () => {
      // A compiled binary shipped alongside its `dist/` — `<execDir>/../dist`.
      const binary = installBinary(join(root, "beside", "bin", "ocpp-cp-sim"));
      writeConsole(join(root, "beside", "dist"), "SENTINEL_BESIDE_BINARY");
      const result = await launch(
        binary,
        buildArgs({
          port: await freePort(),
          stateDb: join(root, "beside", "state.db"),
          webConsoleDist: null,
        }),
      );
      if (!result.ready) console.error(result.stderr);
      expect(result.ready).toBe(true);
      expect(result.body).toContain("SENTINEL_BESIDE_BINARY");
    },
    SPLASH.timeoutMs + 60_000,
  );

  it(
    "finds the console inside a macOS .app layout",
    async () => {
      // Contents/MacOS/<sidecar> + Contents/Resources/web-console — the
      // layout `bundle.resources` produces, so a hand-run
      // `OCPP CP Simulator.app/Contents/MacOS/ocpp-cp-sim` also works.
      const app = join(root, "OCPP CP Simulator.app", "Contents");
      const binary = installBinary(join(app, "MacOS", "ocpp-cp-sim"));
      writeConsole(join(app, "Resources", "web-console"), "SENTINEL_DOT_APP");
      const result = await launch(
        binary,
        buildArgs({
          port: await freePort(),
          stateDb: join(root, "dotapp-state.db"),
          webConsoleDist: null,
        }),
      );
      if (!result.ready) console.error(result.stderr);
      expect(result.ready).toBe(true);
      expect(result.body).toContain("SENTINEL_DOT_APP");
    },
    SPLASH.timeoutMs + 60_000,
  );

  it(
    "names every path it searched when there is no console to serve",
    async () => {
      // The old message said only "run `bun run build` in the repo first",
      // which tells someone who double-clicked a .dmg nothing at all.
      const binary = installBinary(join(root, "empty", "bin", "ocpp-cp-sim"));
      const result = await launch(
        binary,
        buildArgs({
          port: await freePort(),
          stateDb: join(root, "empty", "state.db"),
          webConsoleDist: null,
        }),
      );
      expect(result.ready).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(join(root, "empty", "dist"));
      expect(result.stderr).toContain(join(root, "empty", "bin", "dist"));
      expect(result.stderr).toContain("process.execPath");
      expect(result.stderr).toContain("--web-console-dist");
    },
    SPLASH.timeoutMs + 60_000,
  );

  it(
    "refuses an explicit --web-console-dist that holds no console",
    async () => {
      // An override that is wrong must fail loudly rather than fall back to
      // some other directory and serve a stale UI.
      const binary = installBinary(join(root, "wrong", "bin", "ocpp-cp-sim"));
      writeConsole(join(root, "wrong", "dist"), "SENTINEL_SHOULD_NOT_SERVE");
      const missing = join(root, "wrong", "not-here");
      const result = await launch(
        binary,
        buildArgs({
          port: await freePort(),
          stateDb: join(root, "wrong", "state.db"),
          webConsoleDist: missing,
        }),
      );
      expect(result.ready).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(missing);
    },
    SPLASH.timeoutMs + 60_000,
  );
});
