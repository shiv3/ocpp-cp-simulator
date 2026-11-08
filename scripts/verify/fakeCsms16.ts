// A small OCPP 1.6J central system over a real WebSocket, for the stage D2
// verification runs (k6, browser): it accepts every charge point, answers
// BootNotification / Heartbeat / the notifications, optionally sends one
// UpdateFirmware per charge point after its boot, and records every frame.
//
//   bun scripts/verify/fakeCsms16.ts --port 9100 --log /work/scratch/frames.jsonl \
//     [--update-firmware] [--max-frames 100000]
import { appendFileSync, writeFileSync } from "node:fs";

export interface FakeCsmsOptions {
  port: number;
  /** Append every frame as one JSON line to this file. */
  logFile?: string;
  /** Send UpdateFirmware to each charge point after its BootNotification. */
  updateFirmware?: boolean;
  /** Keep every frame in `frames` (default true); off for a large fleet. */
  keepFrames?: boolean;
}

export interface FrameRecord {
  t: number;
  cp: string;
  dir: "in" | "out";
  frame: unknown;
}

export interface FakeCsmsHandle {
  readonly port: number;
  readonly frames: FrameRecord[];
  readonly connected: Set<string>;
  stop(): void;
}

interface Socket {
  cp: string;
  seq: number;
}

export function startFakeCsms(opts: FakeCsmsOptions): FakeCsmsHandle {
  const frames: FrameRecord[] = [];
  const connected = new Set<string>();
  if (opts.logFile) writeFileSync(opts.logFile, "");
  const record = (cp: string, dir: "in" | "out", frame: unknown): void => {
    if (opts.keepFrames === false && !opts.logFile) return;
    const rec: FrameRecord = { t: Date.now(), cp, dir, frame };
    if (opts.keepFrames !== false) frames.push(rec);
    if (opts.logFile) appendFileSync(opts.logFile, `${JSON.stringify(rec)}\n`);
  };
  const server = Bun.serve<Socket>({
    port: opts.port,
    fetch(req, srv) {
      const cp = decodeURIComponent(
        new URL(req.url).pathname.split("/").pop() ?? "",
      );
      const ok = srv.upgrade(req, {
        data: { cp, seq: 0 },
        headers: { "Sec-WebSocket-Protocol": "ocpp1.6" },
      });
      return ok ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        connected.add(ws.data.cp);
      },
      close(ws) {
        connected.delete(ws.data.cp);
      },
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : raw.toString();
        let msg: unknown[];
        try {
          msg = JSON.parse(text) as unknown[];
        } catch {
          return;
        }
        const cp = ws.data.cp;
        record(cp, "in", msg);
        const send = (frame: unknown[]): void => {
          record(cp, "out", frame);
          ws.send(JSON.stringify(frame));
        };
        if (msg[0] !== 2) return;
        const [, id, action] = msg as [number, string, string];
        if (action === "BootNotification") {
          send([
            3,
            id,
            {
              status: "Accepted",
              currentTime: new Date().toISOString(),
              interval: 300,
            },
          ]);
          if (opts.updateFirmware) {
            setTimeout(() => {
              send([
                2,
                `csms-${cp}-${++ws.data.seq}`,
                "UpdateFirmware",
                {
                  location: "http://example.invalid/fw.bin",
                  retrieveDate: new Date().toISOString(),
                  requestId: 1,
                },
              ]);
            }, 50);
          }
        } else if (action === "Heartbeat") {
          send([3, id, { currentTime: new Date().toISOString() }]);
        } else {
          send([3, id, {}]);
        }
      },
    },
  });
  return {
    port: server.port ?? opts.port,
    frames,
    connected,
    stop: () => void server.stop(true),
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const handle = startFakeCsms({
    port: Number(arg("--port") ?? 9100),
    logFile: arg("--log"),
    updateFirmware: process.argv.includes("--update-firmware"),
    keepFrames: !process.argv.includes("--no-frames"),
  });
  console.log(`fake CSMS on ws://127.0.0.1:${handle.port}`);
  if (process.argv.includes("--report")) {
    setInterval(() => console.log(`connected ${handle.connected.size}`), 500);
  }
}
