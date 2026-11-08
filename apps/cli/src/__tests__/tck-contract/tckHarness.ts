// Shared rig for the tests under tck-contract/ (#346): the CLI in `--json`
// mode as a child process, with a stub CSMS on a local port, the way
// open-ocpp-tck runs it (stdin JSON Lines in, stdout lines out).
import { fileURLToPath } from "node:url";
import { tcpPort } from "@ocpp-cp-sim/core/test/bunServe";

const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));

/** What the stub CSMS answers; enough for a charge point to boot and charge. */
function answer(action: string, v201: boolean): unknown {
  switch (action) {
    case "BootNotification":
      return {
        status: "Accepted",
        currentTime: new Date().toISOString(),
        interval: 300,
      };
    case "Heartbeat":
      return { currentTime: new Date().toISOString() };
    case "Authorize":
      return v201
        ? { idTokenInfo: { status: "Accepted" } }
        : { idTagInfo: { status: "Accepted" } };
    case "TransactionEvent":
      return {};
    case "StartTransaction":
      return { transactionId: 42, idTagInfo: { status: "Accepted" } };
    case "StopTransaction":
      return { idTagInfo: { status: "Accepted" } };
    default:
      return {};
  }
}

export interface StubCsms {
  readonly url: string;
  /** Every raw text frame the charge point sent. */
  readonly frames: string[];
  stop(): Promise<void>;
}

export function startStubCsms(subprotocol = "ocpp1.6"): StubCsms {
  const frames: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req, {
        headers: { "Sec-WebSocket-Protocol": subprotocol },
      })
        ? undefined
        : new Response("expected websocket upgrade", { status: 426 });
    },
    websocket: {
      message(ws, message) {
        const raw = String(message);
        frames.push(raw);
        const frame = JSON.parse(raw) as unknown[];
        if (frame[0] === 2) {
          ws.send(
            JSON.stringify([
              3,
              frame[1],
              answer(String(frame[2]), subprotocol.startsWith("ocpp2")),
            ]),
          );
        }
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${tcpPort(server)}/ocpp`,
    frames,
    stop: async () => {
      await server.stop(true);
    },
  };
}

/** A CALL payload; tests read nested members of it by path. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Payload = Record<string, any>;

/** The payloads of every CALL the charge point sent for `action`, in order. */
export function sentPayloads(csms: StubCsms, action: string): Payload[] {
  return csms.frames.flatMap((raw) => {
    const frame = JSON.parse(raw) as unknown[];
    return frame[0] === 2 && frame[2] === action ? [frame[3] as Payload] : [];
  });
}

/** Resolves with the payloads once `n` CALLs of `action` have arrived: a
 *  response can overtake the frame it caused on its way to the CSMS. */
export async function waitForPayloads(
  csms: StubCsms,
  action: string,
  n: number,
  ms = 10_000,
): Promise<Payload[]> {
  for (let waited = 0; waited < ms; waited += 25) {
    const hit = sentPayloads(csms, action);
    if (hit.length >= n) return hit;
    await Bun.sleep(25);
  }
  throw new Error(
    `timed out waiting for ${n} ${action} CALL(s); got ${sentPayloads(csms, action).length}`,
  );
}

export interface JsonModeSession {
  /** Sends one command and resolves with the response carrying its id. */
  request(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** Every stdout line so far, in order. */
  readonly stdout: string[];
  /** Resolves with the next stdout line matching `pred` (or one already seen). */
  waitForLine(pred: (line: string) => boolean, ms?: number): Promise<string>;
  /** Closes stdin (EOF) and resolves with the exit code. */
  end(): Promise<number>;
  kill(): void;
}

export function startJsonMode(
  wsUrl: string,
  ocppVersion = "OCPP-1.6J",
): JsonModeSession {
  const proc = Bun.spawn(
    [
      process.execPath,
      "apps/cli/src/main.ts",
      "--json",
      "--ws-url",
      wsUrl,
      "--cp-id",
      "TCKCP",
      "--connectors",
      "2",
      "--ocpp-version",
      ocppVersion,
    ],
    { cwd: repoRoot, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const stdout: string[] = [];
  const watchers = new Set<() => void>();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        stdout.push(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        for (const w of [...watchers]) w();
      }
    }
  })();
  let nextId = 1;

  function waitForLine(
    pred: (line: string) => boolean,
    ms = 15_000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const hit = stdout.find(pred);
        if (hit === undefined) return false;
        watchers.delete(check);
        clearTimeout(timer);
        resolve(hit);
        return true;
      };
      const timer = setTimeout(() => {
        watchers.delete(check);
        reject(
          new Error(
            `timed out waiting for a stdout line; saw:\n${stdout.join("\n")}`,
          ),
        );
      }, ms);
      if (!check()) watchers.add(check);
    });
  }

  return {
    stdout,
    waitForLine,
    async request(command, params) {
      const id = `t${nextId++}`;
      proc.stdin.write(
        `${JSON.stringify({ id, command, ...(params ? { params } : {}) })}\n`,
      );
      await proc.stdin.flush();
      const line = await waitForLine((l) => l.startsWith(`{"id":"${id}"`));
      return JSON.parse(line) as Record<string, unknown>;
    },
    async end() {
      await proc.stdin.end();
      return proc.exited;
    },
    kill() {
      proc.kill();
    },
  };
}
