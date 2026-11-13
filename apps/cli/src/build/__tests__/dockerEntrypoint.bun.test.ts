import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Golden for the surface open-ocpp-tck depends on (#919): the image run on its
// own entrypoint, `docker run -i <image> --json …`. No docker here, so the
// script runs for real with a stub `bun` first on PATH. The stub stands in for
// `bun dist-cli/main.js`: it records its argv, answers each stdin JSON line
// with a JSON reply plus Logger-style `Sent:` / `Received:` lines, exits 0 on
// stdin EOF and on SIGTERM (after saying so). exec in the entrypoint means the
// signal reaches the stub directly, as `docker stop` reaches the CLI.
describe("docker/entrypoint.sh run path, through a stub bun (#919)", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "entrypoint-golden-"));
    const stub = join(dir, "bun");
    writeFileSync(
      stub,
      `#!${process.execPath}
const lines = [];
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
process.on("SIGTERM", () => {
  process.stdout.write("got SIGTERM\\n", () => process.exit(0));
});
process.stdout.write("ready\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const cmd = JSON.parse(line);
    process.stdout.write("Received: " + line + "\\n");
    const reply = JSON.stringify({ id: cmd.id, ok: true });
    process.stdout.write("Sent: " + reply + "\\n");
    process.stdout.write(reply + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`,
    );
    chmodSync(stub, 0o755);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const TCK_ARGS = [
    "--ws-url",
    "ws://csms/ocpp/",
    "--cp-id",
    "CP1",
    "--json",
    "--ocpp-version",
    "OCPP-1.6J",
  ];

  function spawnEntrypoint(args: string[]) {
    return Bun.spawn(["sh", entrypoint, ...args], {
      // HTTP_PORT / STATE_DB are set in the image; CLI mode must ignore them.
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HTTP_PORT: "9700",
        STATE_DB: "/data/state.db",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  it("passes argv through unchanged, answers JSON Lines, exits 0 on stdin EOF", async () => {
    const proc = spawnEntrypoint(TCK_ARGS);
    proc.stdin.write('{"id":1,"command":"status"}\n');
    proc.stdin.write('{"id":2,"command":"status"}\n');
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout.split("\n")).toEqual([
      JSON.stringify({ argv: ["dist-cli/main.js", ...TCK_ARGS] }),
      "ready",
      'Received: {"id":1,"command":"status"}',
      'Sent: {"id":1,"ok":true}',
      '{"id":1,"ok":true}',
      'Received: {"id":2,"command":"status"}',
      'Sent: {"id":2,"ok":true}',
      '{"id":2,"ok":true}',
      "",
    ]);
  });

  it("exits 0 on an empty stdin", async () => {
    const proc = spawnEntrypoint(TCK_ARGS);
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).not.toContain("[server]");
  });

  it("forwards SIGTERM to the CLI", async () => {
    const proc = spawnEntrypoint(TCK_ARGS);
    const reader = proc.stdout.getReader();
    let seen = "";
    const decoder = new TextDecoder();
    // Wait for the stub's handler to be installed before signalling.
    while (!seen.includes("ready\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
    expect(seen).toContain("ready\n");
    proc.kill("SIGTERM");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
    expect(await proc.exited).toBe(0);
    expect(seen).toContain("got SIGTERM\n");
  });
});
