/* eslint-disable @typescript-eslint/no-explicit-any */
/* Regressions of the second review (N2, N3, N4, N9, N10). */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import { runMigrations } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/schema";
import { behaviorsOfModule } from "@ocpp-cp-simulator/core/cp/application/engine/behaviorModule";
import { EventBus } from "../../server/eventBus";
import { CPRegistry } from "../../server/CPRegistry";
import { BehaviorLibrary } from "../../behavior/BehaviorLibrary";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "../../server/__tests__/socketHarness";

const servers: TestServer[] = [];
const sockets: Socket[] = [];
const csmses: Array<{ stop(force?: boolean): void }> = [];
afterEach(async () => {
  while (sockets.length) sockets.pop()?.disconnect();
  while (servers.length) await servers.pop()?.close();
  while (csmses.length) csmses.pop()?.stop(true);
});
const rpc = (s: Socket, method: string, params: unknown): Promise<any> =>
  new Promise((r) => s.emit("rpc", { method, params }, r));

// Every engine refuses it: extend on an action no default answers.
const badExtend = {
  api: 1,
  id: "badExtend",
  onCall: {
    GetConfiguration: { mode: "extend", handle: () => undefined },
  },
} as unknown as Behavior;
const ok: Behavior = { api: 1, id: "ok" };
const b = (id: string): Behavior => ({ api: 1, id });
const BASE = {
  wsUrl: "ws://127.0.0.1:65534/x",
  connectors: 1,
  vendor: "v",
  model: "m",
  basicAuth: null,
} as any;

/** A library that lets through what the real one refuses: only the engine is left to say no. */
class LaxLibrary extends BehaviorLibrary {
  override select(ids: readonly string[] | undefined): Behavior[] {
    return ids?.includes("badExtend") || ids === undefined
      ? [ok, badExtend]
      : super.select(ids);
  }
  override ids(): string[] {
    return ["ok", "badExtend"];
  }
  override get(id: string): Behavior | undefined {
    return id === "ok" ? ok : id === "badExtend" ? badExtend : undefined;
  }
  override check(): void {}
}

function fakeCsms() {
  let open = 0;
  let opened = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (
        srv.upgrade(req, { headers: { "Sec-WebSocket-Protocol": "ocpp1.6" } })
      )
        return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open() {
        open++;
        opened++;
      },
      close() {
        open--;
      },
      message(ws, m) {
        const f = JSON.parse(String(m));
        if (f[0] === 2) {
          const payload =
            f[2] === "BootNotification"
              ? {
                  status: "Accepted",
                  currentTime: new Date().toISOString(),
                  interval: 300,
                }
              : f[2] === "Heartbeat"
                ? { currentTime: new Date().toISOString() }
                : {};
          ws.send(JSON.stringify([3, f[1], payload]));
        }
      },
    },
  });
  csmses.push(server);
  return {
    url: `ws://127.0.0.1:${server.port}/ocpp/`,
    get open() {
      return open;
    },
    get opened() {
      return opened;
    },
  };
}
const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await Bun.sleep(20);
  return f();
};

describe("N2/N4: a behavior every engine refuses never reaches a station", () => {
  it("the library refuses it when the file loads", () => {
    expect(() => BehaviorLibrary.of([ok, badExtend])).toThrow(
      /no default behavior to extend/,
    );
    for (const id of ["default.x", "constructor", "__proto__", "toString"]) {
      expect(() =>
        behaviorsOfModule("f", { default: { api: 1, id } }),
      ).toThrow();
      expect(() => BehaviorLibrary.of([{ api: 1, id } as Behavior])).toThrow();
    }
  });
  it("extend of an action with a default (either spelling) is accepted", () => {
    const ext = (action: string): Behavior =>
      ({
        api: 1,
        id: "e",
        onCall: { [action]: { mode: "extend", handle: () => undefined } },
      }) as unknown as Behavior;
    for (const a of [
      "UpdateFirmware",
      "Reset",
      "RequestStartTransaction",
      "RemoteStartTransaction",
    ]) {
      expect(() => behaviorsOfModule("f", { default: ext(a) })).not.toThrow();
    }
  });
  it("restore keeps every station even when a stored row names a refused behavior", () => {
    const d = BunSqliteDatabase.open(":memory:");
    runMigrations(d);
    const lax = new LaxLibrary();
    const before = new CPRegistry(new EventBus(), d, {
      behaviors: BehaviorLibrary.of([ok]),
    });
    for (const id of ["S1", "S2", "S3"]) {
      before.create({ ...BASE, cpId: id }, { seedDefault: false });
    }
    before.shutdownAll();
    const after = new CPRegistry(new EventBus(), d, { behaviors: lax });
    after.restoreFromDatabase({ connect: false });
    expect(after.list().length).toBe(3);
    after.shutdownAll();
  });
});

describe("N3: a refused cp.update changes nothing", () => {
  it("the station stays connected and keeps its scenarios and its mains", async () => {
    const csms = fakeCsms();
    const server = await startTestServer({
      behaviors: BehaviorLibrary.of([ok]),
    });
    servers.push(server);
    // Only the engine refuses badExtend: swap in the lax library for the update.
    (server.registry as any).library = new LaxLibrary();
    const socket = await connectTestClient(server);
    sockets.push(socket);
    const made = await rpc(socket, "cp.create", {
      wsUrl: csms.url,
      connectors: 1,
      cpId: "A",
      behaviors: ["ok"],
    });
    expect(made.ok).toBe(true);
    await server.registry.get("A")!.connect();
    expect(await until(() => csms.open === 1)).toBe(true);
    const scenariosBefore = server.registry
      .get("A")!
      .snapshotScenarios().length;
    expect(scenariosBefore).toBeGreaterThan(0);
    const upd = await rpc(socket, "cp.update", {
      wsUrl: csms.url,
      connectors: 1,
      cpId: "A",
      behaviors: ["ok", "badExtend"],
    });
    expect(upd.ok).toBe(false);
    await Bun.sleep(300);
    const svc = server.registry.get("A")!;
    expect({
      open: csms.open,
      opened: csms.opened,
      scenarios: svc.snapshotScenarios().length,
    }).toEqual({ open: 1, opened: 1, scenarios: scenariosBefore });
  });
});

describe("N9: the stored selection does not follow a removed id", () => {
  it("a new station under a removed id does not inherit it", () => {
    const d = BunSqliteDatabase.open(":memory:");
    runMigrations(d);
    const first = new CPRegistry(new EventBus(), d, {
      behaviors: BehaviorLibrary.of([b("a"), b("b")]),
    });
    first.create(
      { ...BASE, cpId: "X", behaviors: ["a", "b"] },
      { seedDefault: false },
    );
    first.shutdownAll();
    const reg = new CPRegistry(new EventBus(), d, {
      behaviors: BehaviorLibrary.of([b("a")]),
    });
    reg.restoreFromDatabase({ connect: false });
    reg.remove("X");
    reg.create({ ...BASE, cpId: "X", behaviors: [] }, { seedDefault: false });
    reg.update({ ...BASE, cpId: "X", vendor: "v2" });
    const row = d.get<{ behaviors: string | null }>(
      "SELECT behaviors FROM charge_points WHERE cp_id = ?",
      ["X"],
    );
    expect(row?.behaviors).toBe("[]");
    reg.shutdownAll();
  });
});

describe("N10: the rollback of a refused update does not persist a derived SOAP URL (#183)", () => {
  it("soap_callback_url stays NULL", () => {
    const d = BunSqliteDatabase.open(":memory:");
    runMigrations(d);
    const init = {
      ...BASE,
      cpId: "S",
      wsUrl: "http://127.0.0.1:65534/soap",
      ocppVersion: "OCPP-1.6S",
      behaviors: [],
    };
    const reg = new CPRegistry(new EventBus(), d, {
      soapPublicBaseUrl: "https://tunnel-1.example",
      behaviors: new LaxLibrary(),
    } as any);
    reg.create(init, { seedDefault: false });
    const read = () =>
      d.get<{ soap_callback_url: string | null }>(
        "SELECT soap_callback_url FROM charge_points WHERE cp_id = 'S'",
        [],
      )?.soap_callback_url;
    expect(read()).toBeNull();
    expect(() => reg.update({ ...init, behaviors: ["badExtend"] })).toThrow();
    expect(read()).toBeNull();
    reg.shutdownAll();
  });
});
