// Stage E end-to-end check, run by hand:
//
//   bun scripts/verify/e2e/behaviorsDaemon.ts
//
// It starts the real daemon (`apps/cli/src/main.ts`, `--watch-behaviors`) with
// three behavior files, a small local CSMS over a real WebSocket, and two
// charge points that are each assigned different behaviors by id:
//
//   CP-A  disconnect-on-charging (the shipped example) and answer-reset
//   CP-B  reset-rejects
//
// It then shows, from the frames the CSMS saw: each charge point answering
// Reset with its own behavior; a `beforeSend` shifting the MeterValues of CP-A
// only; an edit of a behavior file taking effect with no restart (same daemon
// process, same sockets); a file that does not build keeping the old version;
// and `behavior.reload` and `cp.behaviors.set` over the control plane.
// Exits 1 when an expectation fails. Prints the timeline either way.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { io } from "socket.io-client";

const repo = path.resolve(import.meta.dir, "../../..");
const dir = mkdtempSync(path.join(tmpdir(), "behaviors-e2e-"));
const port = 18000 + Math.floor(Math.random() * 1000);
const csmsPort = port + 1000;

const answerReset = (status: "accepted" | "rejected"): string => `
import type { Behavior } from "${repo}/packages/contracts/src/behavior";
export default {
  api: 1,
  id: "answer-reset",
  onCall: {
    Reset: { mode: "replace", handle: (_req, ctx) => ({ response: ctx.${status}("Reset") }) },
  },
} satisfies Behavior;
`;
const resetRejects = `
import type { Behavior } from "${repo}/packages/contracts/src/behavior";
export default {
  api: 1,
  id: "reset-rejects",
  onCall: {
    Reset: { mode: "replace", handle: (_req, ctx) => ({ response: ctx.rejected("Reset") }) },
  },
} satisfies Behavior;
`;
const answerResetFile = path.join(dir, "answer-reset.ts");
const resetRejectsFile = path.join(dir, "reset-rejects.ts");
writeFileSync(answerResetFile, answerReset("accepted"));
writeFileSync(resetRejectsFile, resetRejects);

// ---- the CSMS ---------------------------------------------------------------

interface Frame {
  t: number;
  cp: string;
  dir: "CP>" | "CSMS>";
  frame: unknown[];
}
const frames: Frame[] = [];
const sockets = new Map<
  string,
  import("bun").ServerWebSocket<{ cp: string }>
>();
const opens = new Map<string, number>();
const waiting = new Map<string, (frame: unknown[]) => void>();
let txCounter = 0;
const t0 = Date.now();

const csms = Bun.serve<{ cp: string }>({
  port: csmsPort,
  fetch(req, server) {
    const cp = decodeURIComponent(
      new URL(req.url).pathname.split("/").pop() ?? "",
    );
    return server.upgrade(req, {
      data: { cp },
      headers: { "Sec-WebSocket-Protocol": "ocpp1.6" },
    })
      ? undefined
      : new Response("upgrade required", { status: 426 });
  },
  websocket: {
    open(ws) {
      sockets.set(ws.data.cp, ws);
      opens.set(ws.data.cp, (opens.get(ws.data.cp) ?? 0) + 1);
    },
    close(ws) {
      if (sockets.get(ws.data.cp) === ws) sockets.delete(ws.data.cp);
    },
    message(ws, raw) {
      const cp = ws.data.cp;
      let frame: unknown[];
      try {
        frame = JSON.parse(String(raw)) as unknown[];
      } catch {
        frames.push({
          t: Date.now() - t0,
          cp,
          dir: "CP>",
          frame: ["unparsable", String(raw)],
        });
        return;
      }
      frames.push({ t: Date.now() - t0, cp, dir: "CP>", frame });
      if (frame[0] === 3 || frame[0] === 4) {
        waiting.get(String(frame[1]))?.(frame);
        return;
      }
      if (frame[0] !== 2) return;
      const [, id, action] = frame as [number, string, string];
      let result: unknown = {};
      if (action === "BootNotification") {
        result = {
          status: "Accepted",
          currentTime: new Date().toISOString(),
          interval: 300,
        };
      } else if (action === "Heartbeat") {
        result = { currentTime: new Date().toISOString() };
      } else if (action === "StartTransaction") {
        result = {
          transactionId: ++txCounter,
          idTagInfo: { status: "Accepted" },
        };
      } else if (action === "Authorize") {
        result = { idTagInfo: { status: "Accepted" } };
      }
      const answer = [3, id, result];
      frames.push({ t: Date.now() - t0, cp, dir: "CSMS>", frame: answer });
      ws.send(JSON.stringify(answer));
    },
  },
});

let callSeq = 0;
function callCp(
  cp: string,
  action: string,
  payload: unknown,
): Promise<unknown[]> {
  const ws = sockets.get(cp);
  if (!ws) throw new Error(`${cp} is not connected`);
  const id = `csms-${++callSeq}`;
  const frame = [2, id, action, payload];
  frames.push({ t: Date.now() - t0, cp, dir: "CSMS>", frame });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${action} to ${cp}: no answer`)),
      8000,
    );
    waiting.set(id, (answer) => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve(answer);
    });
    ws.send(JSON.stringify(frame));
  });
}

// ---- the daemon -------------------------------------------------------------

const daemon = Bun.spawn(
  [
    "bun",
    path.join(repo, "apps/cli/src/main.ts"),
    "--http-port",
    String(port),
    "--http-host",
    "127.0.0.1",
    "--allow-behavior-code",
    "--watch-behaviors",
    "--behavior",
    path.join(repo, "examples/behaviors/disconnect-on-charging.ts"),
    "--behavior",
    answerResetFile,
    "--behavior",
    resetRejectsFile,
  ],
  { stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } },
);
const daemonLog: string[] = [];
void (async () => {
  const decoder = new TextDecoder();
  const reader = daemon.stderr.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    daemonLog.push(decoder.decode(value));
  }
})();

const failures: string[] = [];
function expectThat(label: string, ok: boolean, detail?: unknown): void {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`,
  );
  if (!ok) failures.push(label);
}
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
async function until(
  label: string,
  ok: () => boolean,
  ms = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

// Ack payloads are loosely typed on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ack = any;
async function main(): Promise<void> {
  const socket = io(`http://127.0.0.1:${port}`, {
    path: "/socket.io/",
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("daemon did not come up")),
      20_000,
    );
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on("connect_error", () => undefined);
    // socket.io retries are off; poll by reconnecting
    const retry = setInterval(() => {
      if (!socket.connected) socket.connect();
      else clearInterval(retry);
    }, 300);
  });
  const rpc = (method: string, params: unknown, cpId?: string): Promise<Ack> =>
    new Promise((resolve) =>
      socket.emit(
        "rpc",
        { method, params, ...(cpId ? { cpId } : {}) },
        resolve,
      ),
    );

  console.log(
    `daemon pid ${daemon.pid}, port ${port}; CSMS port ${csmsPort}\n`,
  );
  const list = await rpc("behavior.list", {});
  expectThat(
    "behavior.list shows the three files",
    list.result?.behaviors?.length === 3 && list.result.watching === true,
    list.result?.behaviors?.map((b: Ack) => b.id),
  );

  const base = {
    wsUrl: `ws://127.0.0.1:${csmsPort}`,
    connectors: 1,
    autoConnect: true,
  };
  const bad = await rpc("cp.create", {
    ...base,
    cpId: "CP-X",
    behaviors: ["nope"],
  });
  expectThat(
    "an unknown id is refused naming the loaded ids",
    bad.ok === false &&
      /loaded behaviors: disconnect-on-charging, answer-reset, reset-rejects/.test(
        bad.error?.message ?? "",
      ),
    bad.error?.message,
  );
  await rpc("cp.create", {
    ...base,
    cpId: "CP-A",
    behaviors: ["disconnect-on-charging", "answer-reset"],
  });
  await rpc("cp.create", {
    ...base,
    cpId: "CP-B",
    behaviors: ["reset-rejects"],
  });
  await until("both charge points booted", () =>
    ["CP-A", "CP-B"].every((cp) =>
      frames.some(
        (f) =>
          f.cp === cp && f.dir === "CP>" && f.frame[2] === "BootNotification",
      ),
    ),
  );
  await sleep(500);

  console.log("\n-- each charge point answers Reset with its own behavior");
  const resetA = await callCp("CP-A", "Reset", { type: "Soft" });
  const resetB = await callCp("CP-B", "Reset", { type: "Soft" });
  expectThat(
    "CP-A (answer-reset) accepts",
    (resetA[2] as Ack)?.status === "Accepted",
    resetA[2],
  );
  expectThat(
    "CP-B (reset-rejects) rejects",
    (resetB[2] as Ack)?.status === "Rejected",
    resetB[2],
  );

  console.log("\n-- beforeSend shifts the MeterValues of CP-A only");
  for (const cp of ["CP-A", "CP-B"]) {
    await rpc("start_transaction", { connector: 1, tagId: `TAG-${cp}` }, cp);
  }
  await until("both transactions started", () =>
    ["CP-A", "CP-B"].every((cp) =>
      frames.some(
        (f) =>
          f.cp === cp && f.dir === "CP>" && f.frame[2] === "StartTransaction",
      ),
    ),
  );
  await sleep(300);
  const reading = async (cp: string): Promise<number> => {
    const from = frames.length;
    await callCp(cp, "TriggerMessage", {
      requestedMessage: "MeterValues",
      connectorId: 1,
    });
    await until(`${cp} MeterValues`, () =>
      frames
        .slice(from)
        .some(
          (f) => f.cp === cp && f.dir === "CP>" && f.frame[2] === "MeterValues",
        ),
    );
    const mv = frames
      .slice(from)
      .find(
        (f) => f.cp === cp && f.dir === "CP>" && f.frame[2] === "MeterValues",
      )!;
    return Number((mv.frame[3] as Ack).meterValue[0].sampledValue[0].value);
  };
  const readingA = await reading("CP-A");
  const readingB = await reading("CP-B");
  expectThat(
    "CP-A reports 1000 more than CP-B (beforeSend of the example)",
    readingA - readingB === 1000,
    { readingA, readingB },
  );
  const mvFrame = frames
    .filter((f) => f.cp === "CP-A" && f.frame[2] === "MeterValues")
    .at(-1)!;
  console.log("   CP-A MeterValues frame:", JSON.stringify(mvFrame.frame));
  console.log(
    "   CP-B MeterValues frame:",
    JSON.stringify(
      frames
        .filter((f) => f.cp === "CP-B" && f.frame[2] === "MeterValues")
        .at(-1)!.frame,
    ),
  );

  console.log(
    "\n-- the connector turned to Charging: CP-A misbehaves (example behavior)",
  );
  await until(
    "CP-A garbage frame",
    () =>
      frames.some(
        (f) =>
          (f.cp === "CP-A" && f.frame[0] === 9) ||
          (f.cp === "CP-A" && f.frame[0] === "unparsable"),
      ),
    8000,
  ).catch(() => undefined);
  const garbage = frames.find((f) => f.cp === "CP-A" && f.frame[0] === 9);
  expectThat(
    "CSMS received the malformed frame from CP-A",
    garbage !== undefined,
    garbage?.frame,
  );

  console.log("\n-- edit a behavior file: reload without a restart");
  const connsBefore = { A: opens.get("CP-A"), B: opens.get("CP-B") };
  writeFileSync(answerResetFile, answerReset("rejected"));
  const deadline = Date.now() + 8000;
  let after: unknown[] = [];
  while (Date.now() < deadline) {
    await sleep(300);
    after = await callCp("CP-A", "Reset", { type: "Soft" });
    if ((after[2] as Ack)?.status === "Rejected") break;
  }
  expectThat(
    "CP-A now rejects Reset (file edit picked up by --watch-behaviors)",
    (after[2] as Ack)?.status === "Rejected",
    after[2],
  );
  expectThat(
    "same daemon process and same sockets",
    daemon.exitCode === null &&
      opens.get("CP-A") === connsBefore.A &&
      opens.get("CP-B") === connsBefore.B,
    { connsBefore, now: { A: opens.get("CP-A"), B: opens.get("CP-B") } },
  );

  console.log("\n-- a file that does not build keeps the old version");
  writeFileSync(answerResetFile, "export default {{{ broken");
  await sleep(1500);
  const kept = await callCp("CP-A", "Reset", { type: "Soft" });
  expectThat(
    "CP-A still rejects (old version kept)",
    (kept[2] as Ack)?.status === "Rejected",
    kept[2],
  );
  expectThat(
    "the daemon logged the failed reload",
    daemonLog.join("").includes("keeping the old version"),
  );

  console.log("\n-- behavior.reload re-reads the same files");
  writeFileSync(answerResetFile, answerReset("accepted"));
  const reloaded = await rpc("behavior.reload", {});
  const row = reloaded.result?.files?.find(
    (f: Ack) => f.file === answerResetFile,
  );
  expectThat(
    "behavior.reload applied it to one charge point",
    reloaded.ok === true && (row?.applied === 1 || row?.unchanged === true),
    row,
  );
  const back = await callCp("CP-A", "Reset", { type: "Soft" });
  expectThat(
    "CP-A accepts again",
    (back[2] as Ack)?.status === "Accepted",
    back[2],
  );
  const refused = await rpc("behavior.reload", { file: "/etc/passwd" });
  expectThat("behavior.reload takes no path", refused.ok === false);

  console.log("\n-- cp.behaviors.set at run time");
  await rpc("cp.behaviors.set", { cpId: "CP-B", behaviors: ["answer-reset"] });
  const swapped = await callCp("CP-B", "Reset", { type: "Soft" });
  expectThat(
    "CP-B now answers like answer-reset",
    (swapped[2] as Ack)?.status === "Accepted",
    swapped[2],
  );
  expectThat(
    "CP-B kept its connection",
    opens.get("CP-B") === connsBefore.B,
    opens.get("CP-B"),
  );

  console.log("\n-- frames (CP-A, in order)");
  for (const f of frames.filter((x) => x.cp === "CP-A")) {
    console.log(
      `   +${String(f.t).padStart(6)}ms ${f.dir} ${JSON.stringify(f.frame)}`,
    );
  }
  socket.disconnect();
}

try {
  await main();
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  daemon.kill();
  csms.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
console.log(
  failures.length === 0
    ? "\nALL CHECKS PASSED"
    : `\n${failures.length} FAILED: ${failures.join("; ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
