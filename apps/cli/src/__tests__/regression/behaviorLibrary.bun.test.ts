/* eslint-disable */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBus } from "../../server/eventBus";
import { CPRegistry } from "../../server/CPRegistry";
import { BehaviorLibrary } from "../../behavior/BehaviorLibrary";

let dir: string;
const stops: Array<() => void> = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sec-lib-"));
});
afterEach(() => {
  while (stops.length) stops.pop()!();
  rmSync(dir, { recursive: true, force: true });
});
const quiet = () => undefined;
const until = async (f: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return f();
};
const b = (id: string, extra = "") =>
  `{ api: 1, id: ${JSON.stringify(id)}, ${extra} }`;
const station = (reg: CPRegistry, cpId: string, behaviors?: string[]) =>
  reg.create(
    {
      cpId,
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 1,
      vendor: "v",
      model: "m",
      basicAuth: null,
      ...(behaviors ? { behaviors } : {}),
    } as any,
    { seedDefault: false },
  );
const running = (svc: any, id: string) =>
  svc._chargePoint.engine.loaded.get(id);

describe("reload outcome", () => {
  it("a station that kept the old version is still reported on the next reload", async () => {
    const f = path.join(dir, "a.ts");
    writeFileSync(f, `export default ${b("a", `marker: "v1"`)};`);
    const lib = await BehaviorLibrary.fromFiles([f], quiet);
    const reg = new CPRegistry(new EventBus(), null, { behaviors: lib });
    const svc = station(reg, "S");
    writeFileSync(
      f,
      `export default ${b("a", `marker: "v2", requires: ["ocpp2.x"]`)};`,
    );
    const [first] = await lib.reload();
    expect(first!.failures.length).toBe(1);
    expect(running(svc, "a").marker).toBe("v1");
    expect(first!.applied).toBe(0);
    // Nothing runs the new version: the file is not "now the version in use".
    expect(first!.ok).toBe(false);
    reg.shutdownAll();
  });

  it("the next reload does not call that file unchanged while a station runs the old version", async () => {
    const f = path.join(dir, "a.ts");
    writeFileSync(f, `export default ${b("a", `marker: "v1"`)};`);
    const lib = await BehaviorLibrary.fromFiles([f], quiet);
    const reg = new CPRegistry(new EventBus(), null, { behaviors: lib });
    const svc = station(reg, "S");
    writeFileSync(
      f,
      `export default ${b("a", `marker: "v2", requires: ["ocpp2.x"]`)};`,
    );
    await lib.reload();
    const [second] = await lib.reload();
    expect(running(svc, "a").marker).toBe("v1");
    expect(second!.unchanged).toBe(false);
    reg.shutdownAll();
  });

  it("a reload is all or nothing per file on one station", async () => {
    const f = path.join(dir, "ab.ts");
    writeFileSync(
      f,
      `export default [${b("a", `marker: "v1"`)}, ${b("b", `marker: "v1"`)}];`,
    );
    const lib = await BehaviorLibrary.fromFiles([f], quiet);
    const reg = new CPRegistry(new EventBus(), null, { behaviors: lib });
    const svc = station(reg, "S");
    writeFileSync(
      f,
      `export default [${b("a", `marker: "v2"`)}, ${b("b", `marker: "v2", requires: ["ocpp2.x"]`)}];`,
    );
    const [r] = await lib.reload();
    expect(r!.failures.length).toBe(1);
    // both old or both new; never a mix of two versions of one file
    expect(running(svc, "a").marker).toBe(running(svc, "b").marker);
    reg.shutdownAll();
  });

  it("a file whose ids became a duplicate is refused like any changed id set", async () => {
    const f = path.join(dir, "ab.ts");
    writeFileSync(
      f,
      `export default [${b("a", `marker: "v1"`)}, ${b("b", `marker: "v1"`)}];`,
    );
    const lib = await BehaviorLibrary.fromFiles([f], quiet);
    writeFileSync(
      f,
      `export default [${b("a", `marker: "v2"`)}, ${b("a", `marker: "v3"`)}];`,
    );
    const [r] = await lib.reload();
    expect(r!.ok).toBe(false);
  });

  it("an unchanged file is left alone: its code does not run again", async () => {
    const f = path.join(dir, "a.ts");
    (globalThis as any).__secRuns = 0;
    writeFileSync(
      f,
      `(globalThis as any).__secRuns++; export default ${b("a")};`,
    );
    const lib = await BehaviorLibrary.fromFiles([f], quiet);
    expect((globalThis as any).__secRuns).toBe(1);
    for (let i = 0; i < 3; i++) {
      const [r] = await lib.reload();
      expect(r!.unchanged).toBe(true);
    }
    expect((globalThis as any).__secRuns).toBe(1);
  });

  it("a module whose top level never settles does not wedge later reloads", async () => {
    const f = path.join(dir, "a.ts");
    writeFileSync(f, `export default ${b("a", `marker: "v1"`)};`);
    const lib = await BehaviorLibrary.fromFiles([f], quiet);
    writeFileSync(
      f,
      `await new Promise(() => {}); export default ${b("a", `marker: "v2"`)};`,
    );
    void lib.reload();
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(f, `export default ${b("a", `marker: "v3"`)};`); // the operator fixes the file
    const fixed = await Promise.race([
      lib.reload().then(() => (lib.get("a") as any).marker),
      new Promise((r) => setTimeout(() => r("still hung"), 3000)),
    ]);
    expect(fixed).toBe("v3");
  }, 8000);
});

describe("watcher", () => {
  const mk = async () => {
    const f = path.join(dir, "a.ts");
    writeFileSync(f, `export default ${b("a", `marker: "v1"`)};`);
    const lib = await BehaviorLibrary.fromFiles([f], quiet);
    stops.push(lib.watch(50));
    await new Promise((r) => setTimeout(r, 100));
    return { f, lib, m: () => (lib.get("a") as any).marker };
  };

  it("plain save", async () => {
    const { f, m } = await mk();
    writeFileSync(f, `export default ${b("a", `marker: "v2"`)};`);
    expect(await until(() => m() === "v2", 3000)).toBe(true);
  });

  it("atomic save by rename", async () => {
    const { f, m } = await mk();
    const t = path.join(dir, ".a.ts.tmp");
    writeFileSync(t, `export default ${b("a", `marker: "v2"`)};`);
    renameSync(t, f);
    expect(await until(() => m() === "v2", 3000)).toBe(true);
  });

  it("delete, then recreate", async () => {
    const { f, m } = await mk();
    unlinkSync(f);
    await new Promise((r) => setTimeout(r, 300));
    expect(m()).toBe("v1");
    writeFileSync(f, `export default ${b("a", `marker: "v2"`)};`);
    expect(await until(() => m() === "v2", 3000)).toBe(true);
  });

  it("half-written file keeps the old version, the rest of the write applies", async () => {
    const { f, m } = await mk();
    writeFileSync(f, `export default { api: 1, id: "a", marker:`);
    await new Promise((r) => setTimeout(r, 300));
    expect(m()).toBe("v1");
    writeFileSync(f, `export default ${b("a", `marker: "v2"`)};`);
    expect(await until(() => m() === "v2", 3000)).toBe(true);
  });

  it("an imported file in a subdirectory counts", async () => {
    mkdirSync(path.join(dir, "lib"));
    const h = path.join(dir, "lib", "h.ts");
    writeFileSync(h, `export const marker = "v1";`);
    const f = path.join(dir, "a.ts");
    writeFileSync(
      f,
      `import { marker } from "./lib/h"; export default { api: 1, id: "a", marker };`,
    );
    const lib = await BehaviorLibrary.fromFiles([f], quiet);
    stops.push(lib.watch(50));
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(h, `export const marker = "v2";`);
    expect(await until(() => (lib.get("a") as any).marker === "v2", 3000)).toBe(
      true,
    );
  });

  it("an edit is applied even while the state db next to the file is busy", async () => {
    // `--state-db ./sim.db --behavior ./a.ts --watch-behaviors`, or a trace in the
    // same directory. Every write of a sibling re-arms the trailing debounce.
    const { f, m } = await mk();
    const noise = path.join(dir, "sim.db-wal");
    const t = setInterval(() => appendFileSync(noise, "x"), 10);
    try {
      writeFileSync(f, `export default ${b("a", `marker: "v2"`)};`);
      expect(await until(() => m() === "v2", 2000)).toBe(true);
    } finally {
      clearInterval(t);
    }
  });

  it("writes to an unrelated file do not re-run the behavior's code", async () => {
    const f = path.join(dir, "a.ts");
    (globalThis as any).__secW = 0;
    writeFileSync(f, `(globalThis as any).__secW++; export default ${b("a")};`);
    const lib = await BehaviorLibrary.fromFiles([f], quiet);
    stops.push(lib.watch(20));
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 4; i++) {
      appendFileSync(path.join(dir, "sim.db"), "x");
      await new Promise((r) => setTimeout(r, 150));
    }
    expect((globalThis as any).__secW).toBe(1);
  });
});

describe("runtime of a loaded bundle", () => {
  it("a lazy dynamic import in a behavior works after the load", async () => {
    writeFileSync(path.join(dir, "h.ts"), `export const v = 42;`);
    const f = path.join(dir, "a.ts");
    writeFileSync(
      f,
      `export default { api: 1, id: "a", lazy: async () => (await import("./h")).v };`,
    );
    const lib = await BehaviorLibrary.fromFiles([f], quiet);
    expect(await (lib.get("a") as any).lazy()).toBe(42);
  });
});
