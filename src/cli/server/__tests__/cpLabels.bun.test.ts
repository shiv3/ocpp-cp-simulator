/* eslint-disable @typescript-eslint/no-explicit-any -- test ack payloads */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import { LABELS_MAX_ENTRIES } from "../../../protocol";
import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import {
  connectTestClient,
  startTestServer,
  waitForSocketEvent,
  type TestServer,
  type TestServerOptions,
} from "./socketHarness";

// #446: generic charge-point labels — create/update semantics, the in-place
// `cp.labels.set`, the `cp.list` selector and persistence across a restart.

const servers: TestServer[] = [];
const sockets: Socket[] = [];

async function closeAll(): Promise<void> {
  while (sockets.length > 0) sockets.pop()?.disconnect();
  while (servers.length > 0) await servers.pop()?.close();
}

afterEach(closeAll);

async function client(options: TestServerOptions = {}) {
  const server = await startTestServer(options);
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

async function labelsOf(socket: Socket, cpId: string) {
  const list = await rpc(socket, "cp.list", {});
  const item = (list.result as any[]).find((cp) => cp.cpId === cpId);
  return item?.labels;
}

const BASE = { wsUrl: "ws://example.test/ocpp/", connectors: 1 };
const LABELS = { site: "oberkirch-01", tenant: "customer-a", env: "lab" };

describe("charge-point labels on create and read (#446)", () => {
  it("returns the labels given at creation from cp.list and status", async () => {
    const { socket } = await client();
    const created = await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "CP1",
      labels: LABELS,
    });
    expect(created.ok).toBe(true);

    expect(await labelsOf(socket, "CP1")).toEqual(LABELS);
    const status = await new Promise<any>((resolve) =>
      socket.emit(
        "rpc",
        { cpId: "CP1", method: "status", params: {} },
        resolve,
      ),
    );
    expect(status.result.config.labels).toEqual(LABELS);
  });

  it("omits labels for a charge point created without any, or with {}", async () => {
    const { socket } = await client();
    await rpc(socket, "cp.create", { ...BASE, cpId: "CP-NONE" });
    await rpc(socket, "cp.create", { ...BASE, cpId: "CP-EMPTY", labels: {} });
    expect(await labelsOf(socket, "CP-NONE")).toBeUndefined();
    expect(await labelsOf(socket, "CP-EMPTY")).toBeUndefined();
  });

  it("refuses an invalid key and an oversized map without creating anything", async () => {
    const { socket } = await client();
    const badKey = await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "CP-BAD",
      labels: { "not a key": "x" },
    });
    expect(badKey.ok).toBe(false);
    expect(badKey.error.code).toBe("invalid_params");

    const tooMany = Object.fromEntries(
      Array.from({ length: LABELS_MAX_ENTRIES + 1 }, (_, i) => [`k${i}`, "v"]),
    );
    const oversized = await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "CP-BIG",
      labels: tooMany,
    });
    expect(oversized.ok).toBe(false);
    expect(oversized.error.code).toBe("invalid_params");

    const list = await rpc(socket, "cp.list", {});
    expect(list.result).toEqual([]);
  });
});

describe("cp.update and labels (#446)", () => {
  it("keeps the labels when the update does not mention them", async () => {
    const { socket } = await client();
    await rpc(socket, "cp.create", { ...BASE, cpId: "CP1", labels: LABELS });
    const updated = await rpc(socket, "cp.update", {
      ...BASE,
      cpId: "CP1",
      vendor: "Other",
    });
    expect(updated.ok).toBe(true);
    expect(await labelsOf(socket, "CP1")).toEqual(LABELS);
  });

  it("replaces the whole map when the update gives one", async () => {
    const { socket } = await client();
    await rpc(socket, "cp.create", { ...BASE, cpId: "CP1", labels: LABELS });
    await rpc(socket, "cp.update", {
      ...BASE,
      cpId: "CP1",
      labels: { env: "prod" },
    });
    expect(await labelsOf(socket, "CP1")).toEqual({ env: "prod" });
  });

  it("clears every label when the update gives {}", async () => {
    const { socket } = await client();
    await rpc(socket, "cp.create", { ...BASE, cpId: "CP1", labels: LABELS });
    await rpc(socket, "cp.update", { ...BASE, cpId: "CP1", labels: {} });
    expect(await labelsOf(socket, "CP1")).toBeUndefined();
  });
});

describe("cp.labels.set (#446)", () => {
  it("replaces the labels without rebuilding the charge point", async () => {
    const { server, socket } = await client();
    await rpc(socket, "cp.create", { ...BASE, cpId: "CP1", labels: LABELS });
    const before = server.registry.get("CP1");

    const ack = await rpc(socket, "cp.labels.set", {
      cpId: "CP1",
      labels: { site: "lyon-02" },
    });

    expect(ack).toEqual({ ok: true, result: { cpId: "CP1" } });
    expect(await labelsOf(socket, "CP1")).toEqual({ site: "lyon-02" });
    // Same service instance: no cleanup, no new transport — the connection
    // and any running transaction survive. `cp.update` would replace it.
    expect(server.registry.get("CP1")).toBe(before);
    await rpc(socket, "cp.update", { ...BASE, cpId: "CP1" });
    expect(server.registry.get("CP1")).not.toBe(before);
  });

  it("clears the labels with {}", async () => {
    const { socket } = await client();
    await rpc(socket, "cp.create", { ...BASE, cpId: "CP1", labels: LABELS });
    await rpc(socket, "cp.labels.set", { cpId: "CP1", labels: {} });
    expect(await labelsOf(socket, "CP1")).toBeUndefined();
  });

  it("answers not_found for an unknown charge point", async () => {
    const { socket } = await client();
    const ack = await rpc(socket, "cp.labels.set", {
      cpId: "NOPE",
      labels: LABELS,
    });
    expect(ack.ok).toBe(false);
    expect(ack.error.code).toBe("not_found");
  });

  it("cp.update pushes a registry `updated` event too, even when nothing else moves", async () => {
    const { socket } = await client();
    await rpc(socket, "cp.create", { ...BASE, cpId: "CP1" });
    await socket.timeout(2_000).emitWithAck("events.subscribe", {
      scope: "registry",
    });

    const pushed = waitForSocketEvent(socket, "event");
    await rpc(socket, "cp.update", { ...BASE, cpId: "CP1", labels: LABELS });
    const [envelope] = (await pushed) as [any];

    expect(envelope.change).toBe("updated");
    expect(envelope.cp.labels).toEqual(LABELS);
  });

  it("pushes a registry `updated` event carrying the new labels", async () => {
    const { socket } = await client();
    await rpc(socket, "cp.create", { ...BASE, cpId: "CP1" });
    await socket.timeout(2_000).emitWithAck("events.subscribe", {
      scope: "registry",
    });

    const pushed = waitForSocketEvent(socket, "event");
    await rpc(socket, "cp.labels.set", { cpId: "CP1", labels: LABELS });
    const [envelope] = (await pushed) as [any];

    expect(envelope.kind).toBe("registry");
    expect(envelope.change).toBe("updated");
    expect(envelope.cp.cpId).toBe("CP1");
    expect(envelope.cp.labels).toEqual(LABELS);
  });
});

describe("cp.list label selector (#446)", () => {
  async function fleet() {
    const { socket } = await client();
    await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "A",
      labels: { site: "s1", env: "lab" },
    });
    await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "B",
      labels: { site: "s1", env: "prod" },
    });
    await rpc(socket, "cp.create", {
      ...BASE,
      cpId: "C",
      labels: { site: "s2", env: "lab" },
    });
    await rpc(socket, "cp.create", { ...BASE, cpId: "D" });
    return socket;
  }

  async function ids(socket: Socket, params: unknown): Promise<string[]> {
    const ack = await rpc(socket, "cp.list", params);
    expect(ack.ok).toBe(true);
    return (ack.result as Array<{ cpId: string }>).map((cp) => cp.cpId).sort();
  }

  it("returns every charge point without a selector", async () => {
    const socket = await fleet();
    expect(await ids(socket, {})).toEqual(["A", "B", "C", "D"]);
    expect(await ids(socket, { labels: {} })).toEqual(["A", "B", "C", "D"]);
  });

  it("requires every selector pair to match (AND)", async () => {
    const socket = await fleet();
    expect(await ids(socket, { labels: { site: "s1" } })).toEqual(["A", "B"]);
    expect(await ids(socket, { labels: { env: "lab" } })).toEqual(["A", "C"]);
    expect(await ids(socket, { labels: { site: "s1", env: "lab" } })).toEqual([
      "A",
    ]);
    expect(await ids(socket, { labels: { site: "nowhere" } })).toEqual([]);
  });

  it("refuses an unknown selector field rather than listing everything", async () => {
    const socket = await fleet();
    const ack = await rpc(socket, "cp.list", { label: { site: "s1" } });
    expect(ack.ok).toBe(false);
    expect(ack.error.code).toBe("invalid_params");
  });
});

describe("cp.create_many and labels (#446)", () => {
  it("gives every charge point of the batch the same labels", async () => {
    const { socket } = await client();
    const ack = await rpc(socket, "cp.create_many", {
      ...BASE,
      count: 2,
      idPattern: "F{n}",
      labels: { fleet: "f1" },
    });
    expect(ack.result.created).toEqual(["F1", "F2"]);
    expect(await labelsOf(socket, "F1")).toEqual({ fleet: "f1" });
    expect(await labelsOf(socket, "F2")).toEqual({ fleet: "f1" });
  });

  it("lets the request's labels replace the blueprint's whole", async () => {
    const { socket } = await client();
    await rpc(socket, "blueprint.save", {
      blueprint: {
        id: "bp",
        name: "Blueprint",
        params: { connectors: 1, labels: { site: "s1", family: "ac" } },
      },
    });

    await rpc(socket, "cp.create_many", {
      blueprintId: "bp",
      wsUrl: BASE.wsUrl,
      count: 1,
      idPattern: "BP{n}",
    });
    await rpc(socket, "cp.create_many", {
      blueprintId: "bp",
      wsUrl: BASE.wsUrl,
      count: 1,
      idPattern: "REQ{n}",
      labels: { env: "lab" },
    });

    await rpc(socket, "cp.create_many", {
      blueprintId: "bp",
      wsUrl: BASE.wsUrl,
      count: 1,
      idPattern: "NONE{n}",
      labels: {},
    });

    // Omitted: inherited. Given: replaces. `{}`: clears the blueprint's.
    expect(await labelsOf(socket, "BP1")).toEqual({ site: "s1", family: "ac" });
    expect(await labelsOf(socket, "REQ1")).toEqual({ env: "lab" });
    expect(await labelsOf(socket, "NONE1")).toBeUndefined();
  });
});

describe("labels survive a daemon restart (#446)", () => {
  it("restores the labels from --state-db, including an in-place relabel", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = await client({ database: db });
      await rpc(first.socket, "cp.create", {
        ...BASE,
        cpId: "CP1",
        labels: LABELS,
      });
      await rpc(first.socket, "cp.create", {
        ...BASE,
        cpId: "CP2",
        labels: LABELS,
      });
      await rpc(first.socket, "cp.labels.set", {
        cpId: "CP2",
        labels: { site: "lyon-02" },
      });
      await closeAll();

      // Not dialled: the CSMS in BASE does not exist.
      const second = await client({ database: db, deferRestoredConnect: true });
      expect(second.server.restored).toEqual(
        expect.arrayContaining(["CP1", "CP2"]),
      );
      expect(await labelsOf(second.socket, "CP1")).toEqual(LABELS);
      expect(await labelsOf(second.socket, "CP2")).toEqual({ site: "lyon-02" });
      const selected = await rpc(second.socket, "cp.list", {
        labels: { site: "lyon-02" },
      });
      expect(selected.result.map((cp: any) => cp.cpId)).toEqual(["CP2"]);
    } finally {
      await closeAll();
      db.close();
    }
  });

  it("drops a corrupted stored label map instead of breaking cp.list", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = await client({ database: db });
      await rpc(first.socket, "cp.create", {
        ...BASE,
        cpId: "CP1",
        labels: LABELS,
      });
      await closeAll();
      db.run("UPDATE charge_points SET labels = ? WHERE cp_id = 'CP1'", [
        JSON.stringify({ "bad key": 1 }),
      ]);

      // Not dialled: the CSMS in BASE does not exist.
      const second = await client({ database: db, deferRestoredConnect: true });
      const list = await rpc(second.socket, "cp.list", {});
      expect(list.ok).toBe(true);
      expect(list.result[0].cpId).toBe("CP1");
      expect(list.result[0].labels).toBeUndefined();
    } finally {
      await closeAll();
      db.close();
    }
  });
});
