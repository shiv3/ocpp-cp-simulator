/* eslint-disable */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import { runMigrations } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/schema";
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
afterEach(async () => {
  while (sockets.length) sockets.pop()?.disconnect();
  while (servers.length) await servers.pop()?.close();
});
const rpc = (s: Socket, method: string, params: unknown): Promise<any> =>
  new Promise((r) => s.emit("rpc", { method, params }, r));

const only16: Behavior = { api: 1, id: "only16", requires: ["ocpp1.6"] };
const only2x: Behavior = { api: 1, id: "only2x", requires: ["ocpp2.x"] };
const BASE = { wsUrl: "ws://127.0.0.1:65534/never", connectors: 1 };

function db() {
  const d = BunSqliteDatabase.open(":memory:");
  runMigrations(d);
  return d;
}
function restart(d: any, behaviors: Behavior[]) {
  const reg = new CPRegistry(new EventBus(), d, {
    behaviors: BehaviorLibrary.of(behaviors),
  });
  return { reg, restored: () => reg.restoreFromDatabase({ connect: false }) };
}

describe("a behavior a station cannot run, and persistence", () => {
  it("cp.behaviors.set that is refused changes nothing in the database", async () => {
    const database = db();
    const server = await startTestServer({
      database,
      behaviors: BehaviorLibrary.of([only2x]),
    });
    servers.push(server);
    const socket = await connectTestClient(server);
    sockets.push(socket);
    const made = await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "A",
      behaviors: [],
    });
    expect(made.ok).toBe(true);
    const set = await rpc(socket, "cp.behaviors.set", {
      cpId: "A",
      behaviors: ["only2x"],
    });
    expect(set.ok).toBe(false); // refused: the 1.6 station cannot run it
    const row = database.get<{ behaviors: string | null }>(
      "SELECT behaviors FROM charge_points WHERE cp_id = ?",
      ["A"],
    );
    expect(row?.behaviors).toBe("[]"); // must still be the old selection
  });

  it("a daemon restart survives the row a refused cp.behaviors.set left behind", async () => {
    const database = db();
    const server = await startTestServer({
      database,
      behaviors: BehaviorLibrary.of([only2x]),
    });
    servers.push(server);
    const socket = await connectTestClient(server);
    sockets.push(socket);
    await rpc(socket, "cp.create", { ...BASE, cpId: "A", behaviors: [] });
    await rpc(socket, "cp.behaviors.set", { cpId: "A", behaviors: ["only2x"] });
    const { restored } = restart(database, [only2x]);
    expect(restored).not.toThrow();
  });

  it("one station with an unmet requires does not take the whole restore down", () => {
    // A fleet with no selection (behaviors NULL = all); the operator adds
    // --behavior only2x.ts (meant for the 2.x stations) and restarts.
    const database = db();
    const before = restart(database, []);
    before.reg.create(
      {
        ...BASE,
        cpId: "OLD16",
        vendor: "v",
        model: "m",
        basicAuth: null,
      } as any,
      { seedDefault: false },
    );
    before.reg.create(
      {
        ...BASE,
        cpId: "NEW2X",
        vendor: "v",
        model: "m",
        basicAuth: null,
        ocppVersion: "OCPP-2.0.1",
      } as any,
      { seedDefault: false },
    );
    before.reg.shutdownAll();
    const after = restart(database, [only2x]);
    expect(after.restored).not.toThrow();
    expect(after.reg.has("NEW2X")).toBe(true);
  });

  it("cp.create refused for an unmet requires leaves no row and no service", async () => {
    const database = db();
    const server = await startTestServer({
      database,
      behaviors: BehaviorLibrary.of([only2x]),
    });
    servers.push(server);
    const socket = await connectTestClient(server);
    sockets.push(socket);
    const made = await rpc(socket, "cp.create", { ...BASE, cpId: "Z" }); // 1.6, absent selection = all
    expect(made.ok).toBe(false);
    expect(server.registry.has("Z")).toBe(false);
    const row = database.get(
      "SELECT cp_id FROM charge_points WHERE cp_id = ?",
      ["Z"],
    );
    expect(row ?? null).toBeNull();
  });

  it("cp.update to a version the behaviors cannot run is refused and keeps the station", async () => {
    const database = db();
    const server = await startTestServer({
      database,
      behaviors: BehaviorLibrary.of([only16]),
    });
    servers.push(server);
    const socket = await connectTestClient(server);
    sockets.push(socket);
    await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "U",
      behaviors: ["only16"],
    });
    const up = await rpc(socket, "cp.update", {
      ...BASE,
      cpId: "U",
      ocppVersion: "OCPP-2.0.1",
    });
    expect(up.ok).toBe(false);
    const row = database.get<{ ocpp_version: string }>(
      "SELECT ocpp_version FROM charge_points WHERE cp_id = ?",
      ["U"],
    );
    expect(row?.ocpp_version).toBe("OCPP-1.6J"); // nothing changed
    expect(server.registry.get("U")!.behaviorIds()).toEqual(["only16"]);
  });
});
