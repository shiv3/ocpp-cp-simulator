import { buildCsms } from "./buildCsms";
import { FrameLog } from "./frameLog";

type CsmsToken = "1.6" | "2.0.1" | "2.1";

interface Ports {
  ocpp: number;
  http: number;
}

export interface CommandResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface CsmsHandle {
  ocppUrl: string;
  frames: FrameLog;
  command(body: Record<string, unknown>): Promise<CommandResponse>;
  stop(): Promise<void>;
}

const PORTS_SENTINEL = "E2E_CSMS_PORTS ";
const STARTUP_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_ATTEMPT_TIMEOUT_MS = 1_000;
const COMMAND_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 3_000;
const MAX_DIAGNOSTIC_LINES = 200;

let buildPromise: Promise<string> | undefined;
const liveHandles = new Set<CsmsHandle>();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

process.once("SIGINT", () => {
  void stopAllCsms().finally(() => process.exit(130));
});

export function csmsToken(simVersion: string): CsmsToken {
  switch (simVersion) {
    case "OCPP-1.6J":
      return "1.6";
    case "OCPP-2.0.1":
      return "2.0.1";
    case "OCPP-2.1":
      return "2.1";
    default:
      throw new Error(`Unsupported simulator OCPP version: ${simVersion}`);
  }
}

export async function startCsms(simVersion: string): Promise<CsmsHandle> {
  buildPromise ??= buildCsms();
  const binPath = await buildPromise;
  const frames = new FrameLog();
  const stderrLines: string[] = [];
  const stdoutBeforePorts: string[] = [];
  const proc = Bun.spawn([binPath, "--version", csmsToken(simVersion)], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let exited = false;
  const exitedPromise = proc.exited.then((code) => {
    exited = true;
    return code;
  });

  let portsSettled = false;
  let resolvePorts: (ports: Ports) => void;
  let rejectPorts: (error: Error) => void;
  const portsPromise = new Promise<Ports>((resolve, reject) => {
    resolvePorts = (ports) => {
      portsSettled = true;
      resolve(ports);
    };
    rejectPorts = (error) => {
      portsSettled = true;
      reject(error);
    };
  });

  const stdoutTask = readLines(proc.stdout, (line) => {
    if (!portsSettled) {
      const ports = parsePortsLine(line);
      if (ports) {
        resolvePorts(ports);
      } else {
        pushDiagnostic(stdoutBeforePorts, line);
      }
      return;
    }

    frames.push(line);
  })
    .then(() => {
      if (!portsSettled) {
        rejectPorts(
          new Error(
            `CSMS stdout closed before ${PORTS_SENTINEL.trim()} sentinel`,
          ),
        );
      }
    })
    .catch((error: unknown) => {
      if (!portsSettled) {
        rejectPorts(toError(error));
      }
    });

  const stderrTask = readLines(proc.stderr, (line) => {
    pushDiagnostic(stderrLines, line);
  }).catch((error: unknown) => {
    pushDiagnostic(
      stderrLines,
      `stderr read failed: ${toError(error).message}`,
    );
  });

  const handle: CsmsHandle = {
    ocppUrl: "",
    frames,
    command: async () => ({ ok: false, error: "CSMS is not ready" }),
    stop: stopProcess,
  };
  let stopPromise: Promise<void> | undefined;

  async function stopProcess(): Promise<void> {
    if (stopPromise) return stopPromise;

    stopPromise = (async () => {
      liveHandles.delete(handle);
      if (!exited) {
        proc.kill("SIGTERM");
        await waitForExitOrTimeout(exitedPromise, STOP_TIMEOUT_MS);
      }
      if (!exited) {
        proc.kill("SIGKILL");
        await waitForExitOrTimeout(exitedPromise, 1_000);
      }
      await Promise.allSettled([stdoutTask, stderrTask]);
    })();

    return stopPromise;
  }

  liveHandles.add(handle);

  try {
    const ports = await waitForPorts(
      portsPromise,
      exitedPromise,
      stderrLines,
      stdoutBeforePorts,
    );
    handle.ocppUrl = `ws://127.0.0.1:${ports.ocpp}/ocpp/`;
    handle.command = (body) => command(ports.http, body);
    await waitForHealthz(ports.http, stderrLines);
    return handle;
  } catch (error) {
    await stopProcess();
    throw error;
  }
}

export async function stopAllCsms(): Promise<void> {
  await Promise.all([...liveHandles].map((handle) => handle.stop()));
}

async function command(
  httpPort: number,
  body: Record<string, unknown>,
): Promise<CommandResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  let text: string;

  try {
    const response = await fetch(`http://127.0.0.1:${httpPort}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (isAbortError(error)) {
      return {
        ok: false,
        error: `Command timed out after ${COMMAND_TIMEOUT_MS}ms`,
      };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (isCommandResponse(parsed)) return parsed;
    return { ok: false, error: `Unexpected command response: ${text}` };
  } catch (_error) {
    return { ok: false, error: `Invalid command response: ${text}` };
  }
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

function parsePortsLine(line: string): Ports | null {
  if (!line.startsWith(PORTS_SENTINEL)) return null;

  try {
    const parsed: unknown = JSON.parse(line.slice(PORTS_SENTINEL.length));
    if (!parsed || typeof parsed !== "object") return null;
    const ports = parsed as Record<string, unknown>;
    if (typeof ports.ocpp !== "number" || typeof ports.http !== "number") {
      return null;
    }
    return { ocpp: ports.ocpp, http: ports.http };
  } catch (_error) {
    return null;
  }
}

async function waitForPorts(
  portsPromise: Promise<Ports>,
  exitedPromise: Promise<number>,
  stderrLines: string[],
  stdoutBeforePorts: string[],
): Promise<Ports> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          [
            `Timed out after ${STARTUP_TIMEOUT_MS}ms waiting for ports sentinel`,
            formatDiagnostics("stdout before sentinel", stdoutBeforePorts),
            formatDiagnostics("stderr", stderrLines),
          ].join("\n"),
        ),
      );
    }, STARTUP_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      portsPromise,
      exitedPromise.then((code) => {
        throw new Error(
          [
            `CSMS exited before ports sentinel with code ${code}`,
            formatDiagnostics("stdout before sentinel", stdoutBeforePorts),
            formatDiagnostics("stderr", stderrLines),
          ].join("\n"),
        );
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForExitOrTimeout(
  exitedPromise: Promise<number>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  try {
    await Promise.race([exitedPromise.then(() => undefined), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForHealthz(
  httpPort: number,
  stderrLines: string[],
): Promise<void> {
  const url = `http://127.0.0.1:${httpPort}/healthz`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "no attempts";
  let remainingMs = deadline - Date.now();

  while (remainingMs > 0) {
    const attemptTimeoutMs = Math.min(HEALTH_ATTEMPT_TIMEOUT_MS, remainingMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      const parsed: unknown = await response.json();
      if (response.ok && isHealthzResponse(parsed)) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = isAbortError(error)
        ? `health fetch timed out after ${attemptTimeoutMs}ms`
        : toError(error).message;
    } finally {
      clearTimeout(timer);
    }

    await sleep(50);
    remainingMs = deadline - Date.now();
  }

  throw new Error(
    [
      `Timed out after ${HEALTH_TIMEOUT_MS}ms waiting for ${url}`,
      `last error: ${lastError}`,
      formatDiagnostics("stderr", stderrLines),
    ].join("\n"),
  );
}

function isCommandResponse(value: unknown): value is CommandResponse {
  if (!value || typeof value !== "object") return false;
  return typeof (value as Record<string, unknown>).ok === "boolean";
}

function isHealthzResponse(value: unknown): value is { ok: true } {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>).ok === true;
}

function pushDiagnostic(lines: string[], line: string): void {
  lines.push(line);
  if (lines.length > MAX_DIAGNOSTIC_LINES) lines.shift();
}

function formatDiagnostics(label: string, lines: string[]): string {
  if (lines.length === 0) return `${label}: <empty>`;
  return `${label}:\n${lines.join("\n")}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}
