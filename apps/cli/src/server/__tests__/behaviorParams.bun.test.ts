/* eslint-disable @typescript-eslint/no-explicit-any -- test ack payloads */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/domain/persistence/BunSqliteDatabase";
import { BehaviorLibrary } from "../../behavior/BehaviorLibrary";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
  type TestServerOptions,
} from "./socketHarness";

// Behavior params (#654): the same params everywhere a behavior is selected,
// ids and JSON only.

const servers: TestServer[] = [];
const sockets: Socket[] = [];
async function closeAll(): Promise<void> {
  while (sockets.length > 0) sockets.pop()?.disconnect();
  while (servers.length > 0) await servers.pop()?.close();
}
afterEach(closeAll);

const knob: Behavior = {
  api: 1,
  id: "knob",
  params: {
    schema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 0, maximum: 10 },
        label: { type: "string" },
      },
    },
    defaults: { count: 1, label: "a" },
  },
  onCall: {
    Reset: {
      mode: "replace",
      handle: () => ({ response: { status: "Accepted" } }),
    },
  },
};
const plain: Behavior = { api: 1, id: "plain" };

async function client(options: TestServerOptions = {}) {
  const server = await startTestServer({
    behaviors: BehaviorLibrary.of([knob, plain]),
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
const paramsOf = (server: TestServer, cpId: string, id: string) =>
  server.registry.get(cpId)!.effectiveBehaviorParams(id);

describe("cp.create / cp.update", () => {
  it("sets params for a loaded behavior and for a built-in one", async () => {
    const { server, socket } = await client();
    const ack = await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "A",
      behaviorParams: {
        knob: { count: 5 },
        "default.firmware": { stepMs: 250, failAt: "DownloadFailed" },
      },
    });
    expect(ack.ok).toBe(true);
    expect(paramsOf(server, "A", "knob")).toEqual({ count: 5, label: "a" });
    expect(paramsOf(server, "A", "default.firmware")).toEqual({
      stepMs: 250,
      failAt: "DownloadFailed",
      startAt: "retrieveDate",
      train: false,
      waitForTransactions: false,
      connectorsUnavailable: false,
      reboot: "none",
      jitterMs: 0,
    });
    const list = (await rpc(socket, "cp.list", {})).result as any[];
    expect(list.find((cp) => cp.cpId === "A")).toBeDefined();
  });

  it("nothing set: the defaults apply", async () => {
    const { server, socket } = await client();
    await rpc(socket, "cp.create", { ...BASE, cpId: "D" });
    expect(paramsOf(server, "D", "default.firmware")).toEqual({
      stepMs: 2000,
      failAt: "none",
      startAt: "retrieveDate",
      train: false,
      waitForTransactions: false,
      connectorsUnavailable: false,
      reboot: "none",
      jitterMs: 0,
    });
    expect(paramsOf(server, "D", "knob")).toEqual({ count: 1, label: "a" });
  });

  it("refuses a value that does not fit, an unknown key, a behavior that is not run, and a behavior without params; nothing is created", async () => {
    const { server, socket } = await client();
    for (const [behaviorParams, message] of [
      [{ knob: { count: "5" } }, "expected integer"],
      [{ knob: { count: 11 } }, "above the maximum"],
      [{ knob: { nope: 1 } }, "unknown parameter"],
      [{ "default.firmware": { failAt: "Installing" } }, "must be one of"],
      [{ ghost: { a: 1 } }, "does not run"],
      [{ plain: { a: 1 } }, "declares no params"],
    ] as const) {
      const ack = await rpc(socket, "cp.create", {
        ...BASE,
        cpId: "BAD",
        behaviorParams,
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");
      expect(ack.error.message).toContain(message);
      expect(server.registry.has("BAD")).toBe(false);
    }
  });

  it("a behavior that is not selected cannot be given params", async () => {
    const { socket } = await client();
    const ack = await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "N",
      behaviors: ["plain"],
      behaviorParams: { knob: { count: 2 } },
    });
    expect(ack.ok).toBe(false);
    expect(ack.error.message).toContain("selected: plain");
  });

  it("cp.update keeps omitted params and replaces given ones", async () => {
    const { server, socket } = await client();
    await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "U",
      behaviorParams: { knob: { count: 5 } },
    });
    await rpc(socket, "cp.update", { ...BASE, cpId: "U", vendor: "v2" });
    expect(paramsOf(server, "U", "knob").count).toBe(5);
    await rpc(socket, "cp.update", {
      ...BASE,
      cpId: "U",
      behaviorParams: { knob: { count: 6 } },
    });
    expect(paramsOf(server, "U", "knob").count).toBe(6);
    const bad = await rpc(socket, "cp.update", {
      ...BASE,
      cpId: "U",
      behaviorParams: { knob: { count: 99 } },
    });
    expect(bad.ok).toBe(false);
    expect(paramsOf(server, "U", "knob").count).toBe(6);
  });
});

describe("cp.behaviors.set", () => {
  it("replaces the whole selection, params included, in place", async () => {
    const { server, socket } = await client();
    await rpc(socket, "cp.create", { ...BASE, cpId: "S" });
    const ack = await rpc(socket, "cp.behaviors.set", {
      cpId: "S",
      behaviors: null,
      behaviorParams: {
        knob: { count: 3 },
        "default.reset": { delayMs: 100 },
      },
    });
    expect(ack.ok).toBe(true);
    expect(paramsOf(server, "S", "knob").count).toBe(3);
    expect(paramsOf(server, "S", "default.reset")).toEqual({ delayMs: 100 });
    // Omitted: back to the defaults.
    await rpc(socket, "cp.behaviors.set", { cpId: "S", behaviors: null });
    expect(paramsOf(server, "S", "knob").count).toBe(1);
    expect(paramsOf(server, "S", "default.reset")).toEqual({ delayMs: 0 });
  });

  it("a refused set changes nothing", async () => {
    const { server, socket } = await client();
    await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "S",
      behaviorParams: { knob: { count: 4 } },
    });
    const bad = await rpc(socket, "cp.behaviors.set", {
      cpId: "S",
      behaviors: null,
      behaviorParams: { knob: { count: -1 } },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe("invalid_params");
    expect(paramsOf(server, "S", "knob").count).toBe(4);
  });
});

describe("persistence", () => {
  it("params survive a restart", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = await client({ database: db });
      await rpc(first.socket, "cp.create", {
        ...BASE,
        cpId: "P",
        behaviorParams: {
          knob: { count: 8 },
          "default.signedFirmware": { stepMs: 10 },
        },
      });
      await closeAll();
      const second = await client({ database: db, deferRestoredConnect: true });
      expect(paramsOf(second.server, "P", "knob").count).toBe(8);
      expect(paramsOf(second.server, "P", "default.signedFirmware")).toEqual({
        stepMs: 10,
      });
    } finally {
      await closeAll();
      db.close();
    }
  });

  it("params of a behavior missing for one run survive a cp.update in it", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = await client({ database: db });
      await rpc(first.socket, "cp.create", {
        ...BASE,
        cpId: "P",
        behaviors: ["knob", "plain"],
        behaviorParams: { knob: { count: 8 } },
      });
      await closeAll();
      // The file of `knob` is missing for this run.
      const second = await client({
        database: db,
        deferRestoredConnect: true,
        behaviors: BehaviorLibrary.of([plain]),
      });
      const ack = await rpc(second.socket, "cp.update", {
        ...BASE,
        cpId: "P",
        vendor: "Changed",
      });
      expect(ack.ok).toBe(true);
      await closeAll();
      const third = await client({ database: db, deferRestoredConnect: true });
      expect(paramsOf(third.server, "P", "knob").count).toBe(8);
    } finally {
      await closeAll();
      db.close();
    }
  });

  it("a stored param the behavior no longer accepts is dropped, the station still comes back", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = await client({ database: db });
      await rpc(first.socket, "cp.create", {
        ...BASE,
        cpId: "P",
        behaviorParams: { knob: { count: 8 } },
      });
      await closeAll();
      const narrower: Behavior = {
        ...knob,
        params: {
          ...knob.params!,
          schema: {
            type: "object",
            properties: { count: { type: "integer", maximum: 5 } },
          },
          defaults: { count: 1 },
        },
      };
      const second = await client({
        database: db,
        deferRestoredConnect: true,
        behaviors: BehaviorLibrary.of([narrower]),
      });
      expect(paramsOf(second.server, "P", "knob")).toEqual({ count: 1 });
    } finally {
      await closeAll();
      db.close();
    }
  });
});

describe("behavior.list", () => {
  it("reports each behavior's params schema and defaults", async () => {
    const { socket } = await client();
    const list = await rpc(socket, "behavior.list", {});
    const behaviors = list.result.behaviors as any[];
    expect(behaviors.find((b) => b.id === "knob").params.defaults).toEqual({
      count: 1,
      label: "a",
    });
    expect(behaviors.find((b) => b.id === "plain").params).toBeUndefined();
    const fw = (list.result.defaults as any[]).find(
      (d) => d.id === "default.firmware",
    );
    expect(fw.params.defaults).toEqual({
      stepMs: 2000,
      failAt: "none",
      startAt: "retrieveDate",
      train: false,
      waitForTransactions: false,
      connectorsUnavailable: false,
      reboot: "none",
      jitterMs: 0,
    });
    expect(fw.params.schema.properties.failAt.enum).toEqual([
      "none",
      "DownloadFailed",
      "InstallationFailed",
      "InvalidSignature",
      "InstallVerificationFailed",
    ]);
    // Behaviors without params list none.
    expect(
      (list.result.defaults as any[]).find(
        (d) => d.id === "default.diagnostics",
      ).params,
    ).toBeUndefined();
  });
});

describe("no code over the wire", () => {
  it("a param is a JSON value: source text in a string is data, a non-object is refused", async () => {
    const { server, socket } = await client();
    (globalThis as any).__paramRan = undefined;
    const source = "globalThis.__paramRan = 'ran'";
    const ack = await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "X",
      behaviorParams: { knob: { label: source } },
    });
    expect(ack.ok).toBe(true);
    expect(paramsOf(server, "X", "knob").label).toBe(source);
    // Against an enum the same text is simply not a member.
    const enumAck = await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "Y",
      behaviorParams: { "default.firmware": { failAt: source } },
    });
    expect(enumAck.ok).toBe(false);
    for (const behaviorParams of [
      { knob: source },
      { knob: [source] },
      { knob: "export default {}" },
      { [source]: {} },
    ]) {
      const bad = await rpc(socket, "cp.create", {
        ...BASE,
        cpId: "Z",
        behaviorParams,
      });
      expect(bad.ok).toBe(false);
    }
    expect((globalThis as any).__paramRan).toBeUndefined();
    expect(server.registry.has("Z")).toBe(false);
  });

  it("cp.behaviors.set and cp.create stay strict: no field carries code or a path", async () => {
    const { socket } = await client();
    const ack = await rpc(socket, "cp.behaviors.set", {
      cpId: "X",
      behaviors: [],
      behaviorParams: {},
      module: "/tmp/x.ts",
    });
    expect(ack.ok).toBe(false);
  });

  it("__proto__ never reaches the params object", async () => {
    const { server, socket } = await client();
    const ack = await rpc(
      socket,
      "cp.create",
      JSON.parse(
        `{"wsUrl":"ws://example.test/ocpp/","connectors":1,"cpId":"Q","behaviorParams":{"knob":{"__proto__":{"count":9}}}}`,
      ),
    );
    // Refused, or dropped on the way in; either way it changed nothing.
    if (ack.ok) {
      const params = paramsOf(server, "Q", "knob");
      expect(params).toEqual({ count: 1, label: "a" });
      expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    }
    expect(({} as any).count).toBeUndefined();
  });
});
