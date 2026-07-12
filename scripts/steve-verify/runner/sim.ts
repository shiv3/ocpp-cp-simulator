/**
 * sim.ts -- docker-spawned simulator process: launches `bun src/cli/main.ts
 * --json` inside a container on SteVe's docker network (port of lib.sh's
 * sim_start), feeds it JSON commands directly over the child's stdin (no
 * intermediate feeder shell script -- lib.sh needed one only because its
 * `docker run -d` detaches immediately; spawning attached via Bun.spawn
 * lets this driver write commands with real timing control instead), and
 * streams stdout back as lines for the caller to parse (ocpp.ts) or wait on.
 */

const STOP_GRACE_MS = 10_000;

export interface SimConfig {
  /** docker network the sim container joins (must be SteVe's network so it
   *  can resolve the `app` hostname in wsUrl). */
  network: string;
  /** Simulator container image -- must ship `bun` (used to run the CLI). */
  image: string;
  /** CSMS WebSocket URL, resolved from *inside* the docker network. */
  wsUrl: string;
  /** Repo root, bind-mounted read/write at /app so the container's `bun
   *  src/cli/main.ts` runs this checkout's own source. */
  repoRoot: string;
}

export function defaultSimConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): SimConfig {
  return {
    network: env.STEVE_NETWORK ?? "steve_default",
    image: env.SIM_IMAGE ?? "oven/bun:1.3-alpine",
    wsUrl:
      env.SIM_WS_URL ?? "ws://app:8180/steve/websocket/CentralSystemService/",
    repoRoot,
  };
}

export interface SimProcess {
  readonly cpId: string;
  readonly container: string;
  /** Every stdout line seen so far, in order (JSON events, JSON command
   *  responses, and the plain-text Logger lines ocpp.ts parses). */
  readonly lines: readonly string[];
  /** Writes one JSON command line to the CLI's stdin (JSON Lines protocol). */
  send(command: Record<string, unknown>): Promise<void>;
  /** Resolves with the first line (existing or future) matching `pattern`,
   *  or rejects after `timeoutMs` -- every wait in this module is bounded. */
  waitForLine(pattern: RegExp, timeoutMs: number): Promise<string>;
  /** Closes stdin (lets the CLI exit on its own EOF handler), then
   *  docker-stop/rm the container unconditionally and reap the local
   *  process. Idempotent, never throws. */
  stop(): Promise<void>;
}

function containerName(cpId: string, templateId: string): string {
  return `simts-${cpId.toLowerCase()}-${templateId}`.slice(0, 63);
}

async function runDocker(args: string[]): Promise<void> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    let isDone = false;
    while (!isDone) {
      const result = await reader.read();
      if (result.done) {
        isDone = true;
        continue;
      }
      buffer += decoder.decode(result.value, { stream: true });
      let lineBreak = buffer.indexOf("\n");
      while (lineBreak !== -1) {
        onLine(buffer.slice(0, lineBreak).replace(/\r$/, ""));
        buffer = buffer.slice(lineBreak + 1);
        lineBreak = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) onLine(buffer.replace(/\r$/, ""));
  } finally {
    reader.releaseLock();
  }
}

/** Starts a detached-from-shell but attached-to-us simulator container for
 *  one charge point, running JSON-Lines mode. `templateId` is only used to
 *  build a readable, collision-avoiding container name (mirrors lib.sh's
 *  sim_container_name). */
export async function startSim(
  cpId: string,
  templateId: string,
  cfg: SimConfig,
): Promise<SimProcess> {
  const container = containerName(cpId, templateId);

  // Best-effort cleanup of a stale container from an interrupted previous
  // run with the same name (mirrors lib.sh's sim_start).
  await runDocker(["rm", "-f", container]).catch(() => {});

  const proc = Bun.spawn(
    [
      "docker",
      "run",
      "-i",
      "--rm",
      "--name",
      container,
      "--network",
      cfg.network,
      "-v",
      `${cfg.repoRoot}:/app`,
      "-w",
      "/app",
      cfg.image,
      "bun",
      "src/cli/main.ts",
      "--ws-url",
      cfg.wsUrl,
      "--cp-id",
      cpId,
      "--json",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );

  const lines: string[] = [];
  const stderrLines: string[] = [];
  interface Waiter {
    pattern: RegExp;
    resolve: (line: string) => void;
  }
  const waiters: Waiter[] = [];

  const stdoutTask = readLines(proc.stdout, (line) => {
    lines.push(line);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pattern.test(line)) {
        const [waiter] = waiters.splice(i, 1);
        waiter.resolve(line);
      }
    }
  });
  const stderrTask = readLines(proc.stderr, (line) => {
    stderrLines.push(line);
  });

  function waitForLine(pattern: RegExp, timeoutMs: number): Promise<string> {
    const existing = lines.find((line) => pattern.test(line));
    if (existing !== undefined) return Promise.resolve(existing);

    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = {
        pattern,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      };
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for /${pattern.source}/ on ${container}; ` +
              `last stderr:\n${stderrLines.slice(-20).join("\n")}`,
          ),
        );
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  async function send(command: Record<string, unknown>): Promise<void> {
    proc.stdin.write(`${JSON.stringify(command)}\n`);
    await proc.stdin.flush();
  }

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;

    try {
      await proc.stdin.end();
    } catch {
      // already closed
    }

    await Promise.race([
      proc.exited.then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS)),
    ]);

    // Always stop+rm explicitly, regardless of whether stdin-EOF already
    // made the CLI exit on its own -- mirrors lib.sh's sim_stop, which
    // never trusts `--rm` alone and never fails the caller.
    await runDocker(["stop", container]).catch(() => {});
    await runDocker(["rm", "-f", container]).catch(() => {});

    if (proc.exitCode === null && !proc.killed) {
      proc.kill("SIGKILL");
    }
    await proc.exited.catch(() => {});
    await Promise.allSettled([stdoutTask, stderrTask]);
  }

  return {
    cpId,
    container,
    get lines(): readonly string[] {
      return lines;
    },
    send,
    waitForLine,
    stop,
  };
}
