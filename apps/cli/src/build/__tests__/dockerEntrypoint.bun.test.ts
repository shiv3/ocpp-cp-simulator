import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The image's entrypoint decides between the daemon (server flags appended)
// and the plain CLI (arguments passed through) from its arguments (#346). The
// CLI path is what open-ocpp-tck uses to drive JSON mode without overriding
// the entrypoint, so the argument logic is pinned here. The script is run for
// real with OCPP_ENTRYPOINT_DRY_RUN=1, which prints the argv it would exec
// (one word per line) instead of calling su-exec, which only exists in the
// image. Docker itself is not involved.

const entrypoint = fileURLToPath(
  new URL("../../../../../docker/entrypoint.sh", import.meta.url),
);

function argvFor(args: string[], env: Record<string, string> = {}): string[] {
  const proc = Bun.spawnSync(["sh", entrypoint, ...args], {
    env: { PATH: process.env.PATH ?? "", OCPP_ENTRYPOINT_DRY_RUN: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
  return proc.stdout.toString().trimEnd().split("\n");
}

const DAEMON_FLAGS = [
  "--http-host",
  "0.0.0.0",
  "--unsafe-remote",
  "--web-console",
];

describe("docker/entrypoint.sh argument logic (#346)", () => {
  it("passes JSON mode through without the daemon flags", () => {
    // The TCK's run shape, minus --entrypoint.
    const args = [
      "--json",
      "--ws-url",
      "ws://csms/ocpp/",
      "--cp-id",
      "CP1",
      "--ocpp-version",
      "OCPP-1.6J",
    ];
    expect(argvFor(args, { HTTP_PORT: "9700", STATE_DB: "/data/state.db" })).toEqual([
      "bun",
      "dist-cli/main.js",
      ...args,
    ]);
  });

  it("finds --json anywhere among the arguments", () => {
    const argv = argvFor(["--cp-id", "CP1", "--ws-url", "ws://x/", "--json"]);
    expect(argv).toEqual([
      "bun",
      "dist-cli/main.js",
      "--cp-id",
      "CP1",
      "--ws-url",
      "ws://x/",
      "--json",
    ]);
  });

  it.each(["analyze", "export-k6", "behavior"])(
    "passes the %s subcommand through",
    (sub) => {
      expect(argvFor([sub, "--out", "/tmp/x"])).toEqual([
        "bun",
        "dist-cli/main.js",
        sub,
        "--out",
        "/tmp/x",
      ]);
    },
  );

  it("drops an explicit `cli` first argument and passes the rest through", () => {
    expect(argvFor(["cli", "--cp-id", "CP1", "--ws-url", "ws://x/"])).toEqual([
      "bun",
      "dist-cli/main.js",
      "--cp-id",
      "CP1",
      "--ws-url",
      "ws://x/",
    ]);
    expect(argvFor(["cli", "--help"])).toEqual([
      "bun",
      "dist-cli/main.js",
      "--help",
    ]);
  });

  it("still starts the daemon for a flag-first command line", () => {
    const argv = argvFor(["--cp-id", "cp1", "--ws-url", "ws://x/"], {
      HTTP_PORT: "9700",
      STATE_DB: "/data/state.db",
      HEALTH_PATH: "/v1/healthz",
    });
    expect(argv).toEqual([
      "bun",
      "dist-cli/main.js",
      ...DAEMON_FLAGS,
      "9700",
      "--state-db",
      "/data/state.db",
      "--health-path",
      "/v1/healthz",
      "--cp-id",
      "cp1",
      "--ws-url",
      "ws://x/",
    ]);
  });

  it("starts the daemon with no arguments, and drops unset env flags", () => {
    expect(argvFor([], { HTTP_PORT: "9700" })).toEqual([
      "bun",
      "dist-cli/main.js",
      ...DAEMON_FLAGS,
      "9700",
    ]);
  });

  it("does not mistake a value that merely contains `json` for JSON mode", () => {
    const argv = argvFor(["--log-format", "json", "--cp-id", "cli"], {
      HTTP_PORT: "9700",
    });
    expect(argv).toContain("--web-console");
    expect(argv.slice(-4)).toEqual(["--log-format", "json", "--cp-id", "cli"]);
  });

  it("runs the CLI as the calling user: bun is exec'd directly, never through su-exec", () => {
    // Real run (no dry-run) with stub `bun` and `su-exec` on PATH. A host
    // directory mounted for --trace-output belongs to the host user, and
    // `--user` needs an entrypoint that does not require root.
    const dir = mkdtempSync(join(tmpdir(), "entrypoint-"));
    try {
      writeFileSync(join(dir, "bun"), '#!/bin/sh\necho "bun $*"\n', {
        mode: 0o755,
      });
      writeFileSync(join(dir, "su-exec"), "#!/bin/sh\necho SU-EXEC $*\nexit 9\n", {
        mode: 0o755,
      });
      const proc = Bun.spawnSync(
        ["sh", entrypoint, "--json", "--trace-output", "/trace/x.jsonl"],
        {
          env: { PATH: `${dir}:${process.env.PATH ?? ""}` },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(proc.stdout.toString().trim()).toBe(
        "bun dist-cli/main.js --json --trace-output /trace/x.jsonl",
      );
      expect(proc.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
