/* eslint-disable */
// Real daemon, 127.0.0.1 only.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { io, type Socket } from "socket.io-client";

const MAIN = path.resolve(import.meta.dir, "../../main.ts");
let dir: string;
const procs: any[] = [];
const socks: Socket[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sec-e2e-"));
});
afterEach(async () => {
  while (socks.length) socks.pop()!.disconnect();
  for (const p of procs.splice(0)) {
    p.kill("SIGKILL");
    await p.exited;
  }
  rmSync(dir, { recursive: true, force: true });
});

const port = () => 41000 + Math.floor(Math.random() * 15000);
function daemon(p: number, args: string[]) {
  const proc = Bun.spawn(["bun", MAIN, "--http-port", String(p), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: dir,
  });
  procs.push(proc);
  return proc;
}
async function up(p: number, proc: any, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (proc.exitCode !== null) return false;
    try {
      const r = await fetch(
        `http://127.0.0.1:${p}/socket.io/?EIO=4&transport=polling`,
      );
      if (r.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
async function client(p: number, origin?: string): Promise<Socket> {
  const s = io(`http://127.0.0.1:${p}`, {
    transports: ["polling"],
    reconnection: false,
    ...(origin ? { extraHeaders: { Origin: origin } } : {}),
  });
  socks.push(s);
  await new Promise<void>((res, rej) => {
    s.on("connect", () => res());
    s.on("connect_error", rej);
  });
  return s;
}
const rpc = (
  s: Socket,
  method: string,
  params: unknown,
  cpId?: string,
): Promise<any> =>
  new Promise((r) =>
    s.emit("rpc", { method, params, ...(cpId ? { cpId } : {}) }, r),
  );
const BASE = { wsUrl: "ws://127.0.0.1:9/never", connectors: 1 };
const src = (id: string, extra = "") =>
  `export default { api: 1, id: ${JSON.stringify(id)}, ${extra} };`;

describe("real daemon", () => {
  it("still starts after a client's refused cp.behaviors.set", async () => {
    const f = path.join(dir, "b.ts");
    writeFileSync(f, src("only2x", `requires: ["ocpp2.x"]`));
    const dbf = path.join(dir, "s.db");
    const args = ["--state-db", dbf, "--behavior", f, "--allow-behavior-code"];
    const p1 = port();
    const d1 = daemon(p1, args);
    expect(await up(p1, d1)).toBe(true);
    const s = await client(p1);
    expect(
      (await rpc(s, "cp.create", { ...BASE, cpId: "A", behaviors: [] })).ok,
    ).toBe(true);
    const set = await rpc(s, "cp.behaviors.set", {
      cpId: "A",
      behaviors: ["only2x"],
    });
    expect(set.ok).toBe(false);
    s.disconnect();
    d1.kill("SIGTERM");
    await d1.exited;
    const p2 = port();
    const d2 = daemon(p2, args);
    const ok = await up(p2, d2);
    if (!ok)
      console.log(
        "second daemon stderr:",
        await new Response(d2.stderr).text(),
      );
    expect(ok).toBe(true);
  }, 40000);

  it("--use-behavior is honoured (or refused) for a charge point restored from the state db", async () => {
    const a = path.join(dir, "a.ts"),
      b = path.join(dir, "b.ts");
    writeFileSync(a, src("a"));
    writeFileSync(b, src("b"));
    const dbf = path.join(dir, "s.db");
    const common = [
      "--state-db",
      dbf,
      "--behavior",
      a,
      "--behavior",
      b,
      "--allow-behavior-code",
      "--cp-id",
      "C1",
      "--ws-url",
      "ws://127.0.0.1:9/never",
    ];
    const p1 = port();
    const d1 = daemon(p1, common);
    expect(await up(p1, d1)).toBe(true);
    d1.kill("SIGTERM");
    await d1.exited;
    const p2 = port();
    const d2 = daemon(p2, [...common, "--use-behavior", "a"]);
    expect(await up(p2, d2)).toBe(true);
    const s = await client(p2);
    const list = (await rpc(s, "cp.list", {})).result as any[];
    expect(list.find((c) => c.cpId === "C1")?.behaviors).toEqual(["a"]);
  }, 40000);

  it("a cross-site Origin cannot drive a daemon that runs behavior code", async () => {
    const f = path.join(dir, "b.ts");
    writeFileSync(f, src("x"));
    const p = port();
    const d = daemon(p, ["--behavior", f, "--allow-behavior-code"]);
    expect(await up(p, d)).toBe(true);
    let reached = false;
    try {
      const s = await client(p, "https://evil.example");
      const r = await rpc(s, "behavior.reload", {});
      reached = r.ok === true;
    } catch {
      reached = false;
    }
    expect(reached).toBe(false);
  }, 30000);

  it("without --watch-behaviors new code does not enter a running daemon (rule 5: at start)", async () => {
    const f = path.join(dir, "b.ts");
    const mark = path.join(dir, "ran");
    writeFileSync(f, src("x"));
    const p = port();
    const d = daemon(p, ["--behavior", f, "--allow-behavior-code"]);
    expect(await up(p, d)).toBe(true);
    writeFileSync(
      f,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(mark)}, "1"); ${src("x")}`,
    );
    const s = await client(p);
    await rpc(s, "behavior.reload", {});
    expect(existsSync(mark)).toBe(false);
  }, 30000);

  it("--allow-behavior-reload turns the method on, and says so when it is off", async () => {
    const f = path.join(dir, "b.ts");
    writeFileSync(f, src("x"));
    const off = port();
    daemon(off, ["--behavior", f, "--allow-behavior-code"]);
    expect(await up(off, procs[0])).toBe(true);
    const refused = await rpc(await client(off), "behavior.reload", {});
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain("--allow-behavior-reload");
    const on = port();
    const d = daemon(on, [
      "--behavior",
      f,
      "--allow-behavior-code",
      "--allow-behavior-reload",
    ]);
    expect(await up(on, d)).toBe(true);
    const ok = await rpc(await client(on), "behavior.reload", {});
    expect(ok.ok).toBe(true);
  }, 40000);

  it("--cors-origin widens the same-origin default that --allow-behavior-code sets", async () => {
    const f = path.join(dir, "b.ts");
    writeFileSync(f, src("x"));
    const p = port();
    const d = daemon(p, [
      "--behavior",
      f,
      "--allow-behavior-code",
      "--cors-origin",
      "https://console.example",
    ]);
    expect(await up(p, d)).toBe(true);
    const allowed = await fetch(
      `http://127.0.0.1:${p}/socket.io/?EIO=4&transport=polling`,
      {
        headers: { Origin: "https://console.example" },
      },
    );
    const refused = await fetch(
      `http://127.0.0.1:${p}/socket.io/?EIO=4&transport=polling`,
      {
        headers: { Origin: "https://evil.example" },
      },
    );
    expect(allowed.status).toBe(200);
    expect(refused.status).toBe(403);
  }, 30000);

  it("says on stderr that the same-origin default is on", async () => {
    const f = path.join(dir, "b.ts");
    writeFileSync(f, src("x"));
    const p = port();
    const d = daemon(p, ["--behavior", f, "--allow-behavior-code"]);
    expect(await up(p, d)).toBe(true);
    d.kill("SIGTERM");
    await d.exited;
    expect(await new Response(d.stderr).text()).toContain(
      "same-origin-only CORS",
    );
  }, 30000);
});
