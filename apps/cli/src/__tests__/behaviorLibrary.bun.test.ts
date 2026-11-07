import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BehaviorLibrary,
  UnknownBehaviorError,
} from "../behavior/BehaviorLibrary";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "behavior-library-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const source = (id: string, marker: string): string => `
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
const behavior: Behavior = { api: 1, id: ${JSON.stringify(id)}, onCall: { Reset: { mode: "replace", handle: () => ({ response: { status: ${JSON.stringify(marker)} } }) } } };
export default behavior;
`;

const leftovers = (): string[] =>
  readdirSync(tmpdir()).filter((n) => n.startsWith("ocpp-behavior-"));

describe("BehaviorLibrary", () => {
  test("select: all when absent, the named ones in library order, [] for none", async () => {
    const a = path.join(dir, "a.ts");
    const b = path.join(dir, "b.ts");
    writeFileSync(a, source("a", "x"));
    writeFileSync(b, source("b", "x"));
    const library = await BehaviorLibrary.fromFiles([a, b], () => undefined);
    expect(library.select(undefined).map((x) => x.id)).toEqual(["a", "b"]);
    expect(library.select(["b", "a"]).map((x) => x.id)).toEqual(["a", "b"]);
    expect(library.select([])).toEqual([]);
  });

  test("an unknown id is an error that names the loaded ids", async () => {
    const library = BehaviorLibrary.of([{ api: 1, id: "known" }]);
    expect(() => library.select(["known", "nope"])).toThrow(
      UnknownBehaviorError,
    );
    try {
      library.check(["nope"]);
    } catch (error) {
      expect((error as Error).message).toBe(
        'Unknown behavior id "nope"; loaded behaviors: known',
      );
    }
    expect(() => BehaviorLibrary.of([]).check(["x"])).toThrow(
      /loaded behaviors: none/,
    );
  });

  test("reload picks up an edit, skips an unchanged file, and leaves no temp files", async () => {
    const file = path.join(dir, "r.ts");
    writeFileSync(file, source("r", "Accepted"));
    const before = leftovers().length;
    const library = await BehaviorLibrary.fromFiles([file], () => undefined);
    const seen: string[] = [];
    library.onReplace((id) => {
      seen.push(id);
      return { applied: 1, failures: [] };
    });
    expect((await library.reload())[0]).toMatchObject({
      ok: true,
      unchanged: true,
    });
    expect(seen).toEqual([]);
    writeFileSync(file, source("r", "Rejected"));
    const [result] = await library.reload();
    expect(result).toMatchObject({ ok: true, unchanged: false, applied: 1 });
    expect(seen).toEqual(["r"]);
    const call = library.get("r")!.onCall!.Reset as unknown as {
      handle(req: unknown, ctx: unknown): { response: unknown };
    };
    expect(call.handle({}, {}).response).toEqual({ status: "Rejected" });
    expect(leftovers().length).toBe(before);
  });

  test("a file that does not build keeps the old version", async () => {
    const file = path.join(dir, "bad.ts");
    writeFileSync(file, source("bad", "Accepted"));
    const logs: string[] = [];
    const library = await BehaviorLibrary.fromFiles([file], (m) =>
      logs.push(m),
    );
    const old = library.get("bad");
    writeFileSync(file, "export default {{{ not typescript");
    const [result] = await library.reload();
    expect(result!.ok).toBe(false);
    expect(result!.error).toContain("Cannot load behavior");
    expect(library.get("bad")).toBe(old);
    expect(logs.join("\n")).toContain("keeping the old version");
    // and a later good edit works
    writeFileSync(file, source("bad", "Rejected"));
    expect((await library.reload())[0]!.ok).toBe(true);
    expect(library.get("bad")).not.toBe(old);
  });

  test("a changed set of ids is refused and keeps the old version", async () => {
    const file = path.join(dir, "ids.ts");
    writeFileSync(file, source("one", "Accepted"));
    const library = await BehaviorLibrary.fromFiles([file], () => undefined);
    writeFileSync(file, source("two", "Accepted"));
    const [result] = await library.reload();
    expect(result!.ok).toBe(false);
    expect(result!.error).toContain("restart to add or remove");
    expect(library.ids()).toEqual(["one"]);
  });

  test("reload accepts no paths: it re-reads the ones given at start", async () => {
    const file = path.join(dir, "p.ts");
    writeFileSync(file, source("p", "Accepted"));
    const library = await BehaviorLibrary.fromFiles([file], () => undefined);
    expect(library.paths).toEqual([file]);
    expect(library.reload.length).toBe(0);
  });
});
