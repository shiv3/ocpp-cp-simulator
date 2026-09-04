/* eslint-disable @typescript-eslint/no-explicit-any -- test ack payloads */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import { BunSqliteDatabase } from "../../../cp/domain/persistence/BunSqliteDatabase";
import { BlueprintRepository } from "../../../cp/domain/persistence/BlueprintRepository";
import { BUILT_IN_BLUEPRINTS } from "../../../utils/blueprints";
import { blueprintSchema } from "../../../protocol";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

async function startAndTrack(): Promise<TestServer> {
  const server = await startTestServer();
  servers.push(server);
  return server;
}

function rpc(socket: Socket, method: string, params: unknown): Promise<any> {
  return new Promise((resolve) =>
    socket.emit("rpc", { method, params }, resolve),
  );
}

/** A CP-scoped method, which needs the `cpId` outside `params`. */
function cpRpc(
  socket: Socket,
  cpId: string,
  method: string,
  params: unknown,
): Promise<any> {
  return new Promise((resolve) =>
    socket.emit("rpc", { cpId, method, params }, resolve),
  );
}

const BLUEPRINT = {
  id: "site-a",
  name: "Site A wallbox",
  description: "Two-connector AC unit",
  params: { connectors: 2, vendor: "Acme", model: "A2" },
};

describe("blueprints (#297)", () => {
  it("round-trips through save and list", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const saved = await rpc(socket, "blueprint.save", {
        blueprint: BLUEPRINT,
      });
      expect(saved.ok).toBe(true);
      expect(saved.result.id).toBe("site-a");

      const list = await rpc(socket, "blueprint.list", {});
      const stored = (list.result as Array<{ id: string }>).find(
        (b) => b.id === "site-a",
      );
      expect(stored).toBeDefined();
    } finally {
      socket.disconnect();
    }
  });

  it("survives without --state-db instead of silently dropping the save", async () => {
    // The daemon's default is no database. A save that answered success while
    // storing nothing would be the worst of both, and the common CI case is a
    // throwaway daemon that saves a blueprint and instantiates it in one run.
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      await rpc(socket, "blueprint.save", { blueprint: BLUEPRINT });
      const list = await rpc(socket, "blueprint.list", {});
      expect(
        (list.result as Array<{ id: string }>).some((b) => b.id === "site-a"),
      ).toBe(true);
    } finally {
      socket.disconnect();
    }
  });

  it("lists the built-ins with no setup", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const list = await rpc(socket, "blueprint.list", {});
      const ids = (list.result as Array<{ id: string }>).map((b) => b.id);
      for (const built of BUILT_IN_BLUEPRINTS) {
        expect(ids).toContain(built.id);
      }
    } finally {
      socket.disconnect();
    }
  });

  it("refuses to overwrite or delete a built-in", async () => {
    // `blueprint.delete` cannot restore a built-in, so an accidental overwrite
    // would be permanent for that daemon.
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const overwrite = await rpc(socket, "blueprint.save", {
        blueprint: { ...BLUEPRINT, id: "dc-50kw" },
      });
      expect(overwrite.ok).toBe(false);
      expect(overwrite.error.code).toBe("invalid_params");

      const remove = await rpc(socket, "blueprint.delete", { id: "dc-50kw" });
      expect(remove.ok).toBe(false);

      const list = await rpc(socket, "blueprint.list", {});
      const dc = (list.result as Array<{ id: string; name: string }>).find(
        (b) => b.id === "dc-50kw",
      );
      expect(dc?.name).toBe("DC 50 kW rapid");
    } finally {
      socket.disconnect();
    }
  });

  it("reports not_found for a delete of an id that was never there", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const ack = await rpc(socket, "blueprint.delete", { id: "typo" });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("not_found");
    } finally {
      socket.disconnect();
    }
  });

  it("instantiates a fleet from a blueprint", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      await rpc(socket, "blueprint.save", { blueprint: BLUEPRINT });
      const ack = await rpc(socket, "cp.create_many", {
        blueprintId: "site-a",
        wsUrl: "ws://csms.example/ocpp/",
        count: 3,
        idPattern: "A{n:02}",
      });

      expect(ack.ok).toBe(true);
      expect(ack.result.created).toEqual(["A01", "A02", "A03"]);

      const list = await rpc(socket, "cp.list", {});
      for (const cp of list.result as Array<Record<string, unknown>>) {
        // The blueprint's hardware, the call's CSMS.
        expect(cp.connectors).toBe(2);
        expect(cp.wsUrl).toBe("ws://csms.example/ocpp/");
      }
    } finally {
      socket.disconnect();
    }
  });

  it("lets an explicit parameter override the blueprint's", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      await rpc(socket, "blueprint.save", { blueprint: BLUEPRINT });
      const ack = await rpc(socket, "cp.create_many", {
        blueprintId: "site-a",
        wsUrl: "ws://csms.example/ocpp/",
        connectors: 4,
        count: 1,
        idPattern: "OVR{n}",
      });
      expect(ack.ok).toBe(true);

      const list = await rpc(socket, "cp.list", {});
      expect(
        (list.result as Array<{ connectors: number }>)[0]?.connectors,
      ).toBe(4);
    } finally {
      socket.disconnect();
    }
  });

  it("instantiates a built-in the same way", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const ack = await rpc(socket, "cp.create_many", {
        blueprintId: "dc-150kw",
        wsUrl: "ws://csms.example/ocpp/",
        count: 2,
        idPattern: "HPC{n:02}",
      });
      expect(ack.ok).toBe(true);
      const list = await rpc(socket, "cp.list", {});
      expect(
        (list.result as Array<{ connectors: number }>)[0]?.connectors,
      ).toBe(2);
    } finally {
      socket.disconnect();
    }
  });

  it("refuses an unknown blueprint id rather than creating nothing quietly", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const ack = await rpc(socket, "cp.create_many", {
        blueprintId: "no-such-thing",
        wsUrl: "ws://csms.example/ocpp/",
        count: 2,
        idPattern: "X{n}",
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("not_found");
      expect((await rpc(socket, "cp.list", {})).result).toHaveLength(0);
    } finally {
      socket.disconnect();
    }
  });

  it("still requires a CSMS URL from somewhere", async () => {
    // A built-in carries no wsUrl on purpose: the CSMS is a property of the
    // run. Instantiating one without a URL must fail at the call, not produce
    // charge points that can never connect.
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const ack = await rpc(socket, "cp.create_many", {
        blueprintId: "dc-50kw",
        count: 1,
        idPattern: "NOURL{n}",
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");
      expect((await rpc(socket, "cp.list", {})).result).toHaveLength(0);
    } finally {
      socket.disconnect();
    }
  });
});

describe("BlueprintRepository (#297)", () => {
  it("persists across a restart with --state-db", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      new BlueprintRepository(db).save(BLUEPRINT);
      const reopened = new BlueprintRepository(db);
      expect(reopened.get("site-a")?.name).toBe("Site A wallbox");
      expect(reopened.list()).toHaveLength(1);
      expect(reopened.delete("site-a")).toBe(true);
      expect(reopened.delete("site-a")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("skips a row whose JSON no longer parses rather than failing the list", () => {
    // One bad row must not make `blueprint.list` fail for every other.
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const repo = new BlueprintRepository(db);
      repo.save(BLUEPRINT);
      db.run(
        "INSERT INTO blueprints (id, name, description, definition, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["broken", "Broken", null, "{not json", "t"],
      );
      expect(repo.list().map((b) => b.id)).toEqual(["site-a"]);
    } finally {
      db.close();
    }
  });
});

describe("built-in blueprints (#297)", () => {
  it("all validate against the schema", () => {
    for (const blueprint of BUILT_IN_BLUEPRINTS) {
      expect(blueprintSchema.safeParse(blueprint).success).toBe(true);
    }
  });

  it("have unique ids", () => {
    const ids = BUILT_IN_BLUEPRINTS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carry no wsUrl, since the CSMS belongs to the run", () => {
    for (const blueprint of BUILT_IN_BLUEPRINTS) {
      expect(blueprint.params.wsUrl).toBeUndefined();
    }
  });
});

describe("blueprint defaults reach the charge points (#297)", () => {
  it("applies the blueprint's EV settings to every connector", async () => {
    // The schema promises `evSettings` and `scenarioTemplateId`; copying only
    // `params` left both silently unapplied — including for every built-in,
    // where the EV settings are the point of picking a 150 kW profile.
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      await rpc(socket, "blueprint.save", {
        blueprint: {
          ...BLUEPRINT,
          id: "with-ev",
          evSettings: { maxChargingPowerKw: 111, batteryCapacityKwh: 42 },
        },
      });
      const ack = await rpc(socket, "cp.create_many", {
        blueprintId: "with-ev",
        wsUrl: "ws://csms.example/ocpp/",
        count: 1,
        idPattern: "EV{n}",
      });
      expect(ack.ok).toBe(true);

      // Every connector, not just the first: a blueprint describes the
      // station, and half-configured connectors show up only in the meter.
      for (const connector of [1, 2]) {
        const got = await cpRpc(socket, "EV1", "get_ev_settings", {
          connector,
        });
        expect(got.ok).toBe(true);
        expect(got.result.maxChargingPowerKw).toBe(111);
        expect(got.result.batteryCapacityKwh).toBe(42);
      }
    } finally {
      socket.disconnect();
    }
  });

  it("applies a built-in's EV settings, which is why the profile is chosen", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      const ack = await rpc(socket, "cp.create_many", {
        blueprintId: "dc-150kw",
        wsUrl: "ws://csms.example/ocpp/",
        count: 1,
        idPattern: "HP{n}",
      });
      expect(ack.ok).toBe(true);

      const settings = await cpRpc(socket, "HP1", "get_ev_settings", {
        connector: 1,
      });
      expect(settings.ok).toBe(true);
      expect(settings.result.maxChargingPowerKw).toBe(150);
    } finally {
      socket.disconnect();
    }
  });
});

describe("blueprint ids are non-empty (#297)", () => {
  it("refuses an empty id, which delete could never remove", () => {
    expect(blueprintSchema.safeParse({ ...BLUEPRINT, id: "" }).success).toBe(
      false,
    );
    expect(blueprintSchema.safeParse({ ...BLUEPRINT, name: "" }).success).toBe(
      false,
    );
  });
});
