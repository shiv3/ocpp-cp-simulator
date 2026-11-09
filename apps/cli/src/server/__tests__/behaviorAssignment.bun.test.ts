/* eslint-disable @typescript-eslint/no-explicit-any -- test ack payloads */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Socket } from "socket.io-client";

import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import { BehaviorLibrary } from "../../behavior/BehaviorLibrary";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
  type TestServerOptions,
} from "./socketHarness";

// Per-charger assignment of behaviors: a charge point selects loaded behaviors
// by id, as data. Code enters only through --behavior files.

const servers: TestServer[] = [];
const sockets: Socket[] = [];
const dirs: string[] = [];

async function closeAll(): Promise<void> {
  while (sockets.length > 0) sockets.pop()?.disconnect();
  while (servers.length > 0) await servers.pop()?.close();
}
afterEach(async () => {
  await closeAll();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const behavior = (id: string): Behavior => ({
  api: 1,
  id,
  onCall: {
    Reset: {
      mode: "replace",
      handle: () => ({ response: { status: "Accepted" } }),
    },
  },
});

async function client(options: TestServerOptions = {}) {
  const server = await startTestServer({
    behaviors: BehaviorLibrary.of([behavior("alpha"), behavior("beta")]),
    ...options,
  });
  servers.push(server);
  const socket = await connectTestClient(server);
  sockets.push(socket);
  return { server, socket };
}

function rpc(socket: Socket, method: string, params: unknown): Promise<any> {
  return new Promise((resolve) =>
    socket.emit("rpc", { method, params }, resolve),
  );
}

const BASE = { wsUrl: "ws://example.test/ocpp/", connectors: 1 };

const loadedOn = (server: TestServer, cpId: string): string[] => [
  ...server.registry.get(cpId)!.behaviorIds(),
];

describe("behaviors on create and update", () => {
  it("absent: every loaded behavior; given: just those; []: none", async () => {
    const { server, socket } = await client();
    await rpc(socket, "cp.create", { ...BASE, cpId: "ALL" });
    await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "ONE",
      behaviors: ["beta"],
    });
    await rpc(socket, "cp.create", { ...BASE, cpId: "NONE", behaviors: [] });
    expect(loadedOn(server, "ALL")).toEqual(["alpha", "beta"]);
    expect(loadedOn(server, "ONE")).toEqual(["beta"]);
    expect(loadedOn(server, "NONE")).toEqual([]);
    const list = (await rpc(socket, "cp.list", {})).result as any[];
    const by = (id: string) => list.find((cp) => cp.cpId === id);
    expect(by("ALL").behaviors).toBeUndefined();
    expect(by("ONE").behaviors).toEqual(["beta"]);
    expect(by("NONE").behaviors).toEqual([]);
  });

  it("an unknown id is refused, naming the loaded ids, and nothing is created", async () => {
    const { server, socket } = await client();
    const ack = await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "BAD",
      behaviors: ["alpha", "gamma"],
    });
    expect(ack.ok).toBe(false);
    expect(ack.error.code).toBe("invalid_params");
    expect(ack.error.message).toContain('"gamma"');
    expect(ack.error.message).toContain("alpha, beta");
    expect(server.registry.has("BAD")).toBe(false);
  });

  it("cp.update keeps an omitted selection and replaces a given one", async () => {
    const { server, socket } = await client();
    await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "U",
      behaviors: ["alpha"],
    });
    await rpc(socket, "cp.update", { ...BASE, cpId: "U", vendor: "v2" });
    expect(loadedOn(server, "U")).toEqual(["alpha"]);
    await rpc(socket, "cp.update", { ...BASE, cpId: "U", behaviors: ["beta"] });
    expect(loadedOn(server, "U")).toEqual(["beta"]);
    const bad = await rpc(socket, "cp.update", {
      ...BASE,
      cpId: "U",
      behaviors: ["nope"],
    });
    expect(bad.ok).toBe(false);
    expect(loadedOn(server, "U")).toEqual(["beta"]);
  });

  it("create_many and blueprints carry the selection", async () => {
    const { server, socket } = await client();
    await rpc(socket, "cp.create_many", {
      ...BASE,
      count: 2,
      idPattern: "M{n}",
      behaviors: ["alpha"],
    });
    expect(loadedOn(server, "M1")).toEqual(["alpha"]);
    expect(loadedOn(server, "M2")).toEqual(["alpha"]);
    const saved = await rpc(socket, "blueprint.save", {
      blueprint: {
        id: "bp",
        name: "bp",
        params: { connectors: 1, behaviors: ["beta"] },
      },
    });
    expect(saved.ok).toBe(true);
    await rpc(socket, "cp.create_many", {
      blueprintId: "bp",
      wsUrl: BASE.wsUrl,
      count: 1,
      idPattern: "B{n}",
    });
    expect(loadedOn(server, "B1")).toEqual(["beta"]);
  });
});

describe("cp.behaviors.set", () => {
  it("changes the selection in place and persists it", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = await client({ database: db });
      await rpc(first.socket, "cp.create", { ...BASE, cpId: "S" });
      expect(loadedOn(first.server, "S")).toEqual(["alpha", "beta"]);
      const same = first.server.registry.get("S")!;
      const set = await rpc(first.socket, "cp.behaviors.set", {
        cpId: "S",
        behaviors: ["beta"],
      });
      expect(set.result).toEqual({ cpId: "S", behaviors: ["beta"] });
      // in place: the very same service
      expect(first.server.registry.get("S")).toBe(same);
      expect(loadedOn(first.server, "S")).toEqual(["beta"]);
      await rpc(first.socket, "cp.behaviors.set", {
        cpId: "S",
        behaviors: ["alpha", "beta"],
      });
      expect(loadedOn(first.server, "S")).toEqual(["beta", "alpha"]);
      await rpc(first.socket, "cp.behaviors.set", { cpId: "S", behaviors: [] });
      await closeAll();

      const second = await client({ database: db, deferRestoredConnect: true });
      expect(loadedOn(second.server, "S")).toEqual([]);
      await rpc(second.socket, "cp.behaviors.set", {
        cpId: "S",
        behaviors: null,
      });
      expect(loadedOn(second.server, "S")).toEqual(["alpha", "beta"]);
      const list = (await rpc(second.socket, "cp.list", {})).result as any[];
      expect(list.find((cp) => cp.cpId === "S").behaviors).toBeUndefined();
    } finally {
      await closeAll();
      db.close();
    }
  });

  it("an unknown id changes nothing; an unknown charge point is not_found", async () => {
    const { server, socket } = await client();
    await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "S",
      behaviors: ["alpha"],
    });
    const bad = await rpc(socket, "cp.behaviors.set", {
      cpId: "S",
      behaviors: ["alpha", "zzz"],
    });
    expect(bad.ok).toBe(false);
    expect(bad.error.message).toContain("loaded behaviors: alpha, beta");
    expect(loadedOn(server, "S")).toEqual(["alpha"]);
    const missing = await rpc(socket, "cp.behaviors.set", {
      cpId: "NOPE",
      behaviors: [],
    });
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe("not_found");
  });

  it("a stored id that is no longer loaded is dropped on restore", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = await client({ database: db });
      await rpc(first.socket, "cp.create", {
        ...BASE,
        cpId: "R",
        behaviors: ["alpha", "beta"],
      });
      await closeAll();
      const second = await client({
        database: db,
        deferRestoredConnect: true,
        behaviors: BehaviorLibrary.of([behavior("beta")]),
      });
      expect(loadedOn(second.server, "R")).toEqual(["beta"]);
    } finally {
      await closeAll();
      db.close();
    }
  });
});

describe("no code over the wire", () => {
  it("source text or a path in `behaviors` is an unknown id, never evaluated", async () => {
    const { server, socket } = await client();
    (globalThis as any).__behaviorRan = undefined;
    const payloads = [
      "globalThis.__behaviorRan = 'source'",
      "export default { api: 1, id: 'smuggled' }",
      "/etc/passwd",
      "data:text/javascript,globalThis.__behaviorRan='data'",
    ];
    for (const text of payloads) {
      const created = await rpc(socket, "cp.create", {
        ...BASE,
        cpId: "X",
        behaviors: [text],
      });
      expect(created.ok).toBe(false);
      expect(created.error.message).toContain("Unknown behavior id");
    }
    await rpc(socket, "cp.create", { ...BASE, cpId: "X" });
    for (const text of payloads) {
      const set = await rpc(socket, "cp.behaviors.set", {
        cpId: "X",
        behaviors: [text],
      });
      expect(set.ok).toBe(false);
    }
    expect((globalThis as any).__behaviorRan).toBeUndefined();
    expect(server.registry.library.ids()).toEqual(["alpha", "beta"]);
  });

  it("the methods that touch behaviors take ids or nothing, never a path or source", async () => {
    const { socket } = await client();
    // Extra fields are refused (strict), so there is nowhere to put code.
    for (const [method, params] of [
      ["behavior.reload", { file: "/tmp/x.ts" }],
      ["behavior.reload", { source: "export default {}" }],
      ["behavior.list", { file: "/tmp/x.ts" }],
      ["cp.behaviors.set", { cpId: "X", behaviors: [], source: "x" }],
    ] as const) {
      const ack = await rpc(socket, method, params);
      expect(ack.ok).toBe(false);
    }
    // No method exists that loads one.
    for (const method of ["behavior.load", "behavior.add", "behavior.upload"]) {
      const ack = await rpc(socket, method, { source: "x" });
      expect(ack.ok).toBe(false);
    }
  });
});

describe("behavior.list and behavior.reload", () => {
  it("lists the library; reload re-reads the files given at start", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "behavior-rpc-"));
    dirs.push(dir);
    const file = path.join(dir, "r.ts");
    const source = (status: string): string => `
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
const b: Behavior = { api: 1, id: "rb", onCall: { Reset: { mode: "replace", handle: () => ({ response: { status: ${JSON.stringify(status)} } }) } } };
export default b;`;
    writeFileSync(file, source("Accepted"));
    const library = await BehaviorLibrary.fromFiles([file], () => undefined);
    const { server, socket } = await client({ behaviors: library });
    const list = await rpc(socket, "behavior.list", {});
    expect(list.result).toMatchObject({
      behaviors: [{ id: "rb", file }],
      watching: false,
    });
    // The built-in behaviors and the actions each answers (C1).
    const defaults = list.result.defaults as Array<{
      id: string;
      actions: string[];
    }>;
    expect(defaults.map((d) => d.id)).toContain("default.firmware");
    expect(defaults.find((d) => d.id === "default.reset")?.actions).toEqual([
      "Reset",
    ]);
    await rpc(socket, "cp.create", { ...BASE, cpId: "RB" });
    const before = server.registry.library.get("rb");

    const none = await rpc(socket, "behavior.reload", {});
    expect(none.result.files[0]).toMatchObject({ ok: true, unchanged: true });

    writeFileSync(file, source("Rejected"));
    const reloaded = await rpc(socket, "behavior.reload", {});
    expect(reloaded.result.files[0]).toMatchObject({
      ok: true,
      unchanged: false,
      applied: 1,
    });
    expect(server.registry.library.get("rb")).not.toBe(before);
    expect(server.registry.get("RB")!.behaviorIds()).toEqual(["rb"]);

    writeFileSync(file, "export default {{{ broken");
    const broken = await rpc(socket, "behavior.reload", {});
    expect(broken.result.files[0].ok).toBe(false);
    expect(broken.result.files[0].error).toContain("Cannot load behavior");
    expect(server.registry.get("RB")!.behaviorIds()).toEqual(["rb"]);
  });
});
