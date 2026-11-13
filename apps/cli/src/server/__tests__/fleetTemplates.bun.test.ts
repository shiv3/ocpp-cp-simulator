/* eslint-disable @typescript-eslint/no-explicit-any -- test ack payloads */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { LOOPBACK, tcpPort } from "@ocpp-cp-simulator/core/test/bunServe";
import type { Socket } from "socket.io-client";

import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import type { FleetTemplate } from "@ocpp-cp-simulator/contracts/index";
import { FleetTemplateRepository } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/FleetTemplateRepository";
import { fleetTemplateSchema } from "@ocpp-cp-simulator/contracts/index";
import { NetworkSimManager } from "../NetworkSimManager";
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

async function start(
  options: Parameters<typeof startTestServer>[0] = {},
): Promise<TestServer> {
  const server = await startTestServer(options);
  servers.push(server);
  server.registry.setNetworkSimManager(
    new NetworkSimManager(null, {
      listLiveWsCpIds: () => server.registry.liveWsCpIds(),
      applyToCp: () => {},
      triggerCpDisconnect: () => ({ ok: false, error: "sim_disabled" }),
    }),
  );
  return server;
}

function rpc(socket: Socket, method: string, params: unknown): Promise<any> {
  return new Promise((resolve) =>
    socket.emit("rpc", { method, params }, resolve),
  );
}

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

const WS = "ws://csms.example/ocpp/";

/** The issue's example: two sites, different blueprints and behaviour. */
const LAB = {
  id: "operations-lab",
  name: "Operations lab",
  labels: { env: "lab" },
  groups: [
    {
      name: "site-a",
      labels: { site: "a" },
      members: [
        { cpId: "CP001", blueprintId: "ac-22kw" },
        {
          cpId: "CP002",
          blueprintId: "ac-22kw",
          scenarioTemplateId: "smart-charging",
          labels: { role: "charging" },
        },
        {
          cpId: "CP003",
          blueprintId: "ac-22kw",
          networkSimulation: {
            enabled: true,
            seed: 7,
            rules: { lag: { type: "latency", delayMs: 50 } },
          },
          overrides: { vendor: "Acme", model: "Flaky" },
        },
      ],
    },
    {
      name: "site-b",
      labels: { site: "b" },
      members: [
        {
          idPattern: "DC{n:03}",
          count: 2,
          startIndex: 4,
          blueprintId: "dc-150kw",
          evSettings: { maxChargingPowerKw: 99 },
        },
      ],
    },
  ],
};

async function cpList(socket: Socket): Promise<any[]> {
  return (await rpc(socket, "cp.list", {})).result;
}

describe("fleet templates over the control plane (#445)", () => {
  it("round-trips through save, get, list and delete", async () => {
    const server = await start();
    const socket = await connectTestClient(server);
    try {
      expect(
        (await rpc(socket, "fleet.template.save", { template: LAB })).ok,
      ).toBe(true);
      expect(
        (await rpc(socket, "fleet.template.get", { id: LAB.id })).result,
      ).toEqual(LAB);
      expect(
        (await rpc(socket, "fleet.template.list", {})).result.map(
          (t: any) => t.id,
        ),
      ).toEqual(["operations-lab"]);
      expect(
        (await rpc(socket, "fleet.template.delete", { id: LAB.id })).ok,
      ).toBe(true);
      expect((await rpc(socket, "fleet.template.get", { id: LAB.id })).ok).toBe(
        false,
      );
      expect(
        (await rpc(socket, "fleet.template.delete", { id: LAB.id })).error
          ?.code,
      ).toBe("not_found");
    } finally {
      socket.disconnect();
    }
  });

  it("instantiates different blueprints, scenarios, EV, network and labels from one definition", async () => {
    const server = await start();
    const socket = await connectTestClient(server);
    try {
      await rpc(socket, "fleet.template.save", { template: LAB });
      const ack = await rpc(socket, "fleet.create", {
        templateId: "operations-lab",
        wsUrl: WS,
      });
      expect(ack.ok).toBe(true);
      // Template order, ranges ascending.
      expect(ack.result).toEqual({
        templateId: "operations-lab",
        created: ["CP001", "CP002", "CP003", "DC004", "DC005"],
        failed: [],
      });

      const byId = Object.fromEntries(
        (await cpList(socket)).map((cp: any) => [cp.cpId, cp]),
      );
      expect(byId.CP001.labels).toEqual({ env: "lab", site: "a" });
      expect(byId.CP002.labels).toEqual({
        env: "lab",
        site: "a",
        role: "charging",
      });
      expect(byId.DC004.labels).toEqual({ env: "lab", site: "b" });
      // Blueprint hardware: dc-150kw has two connectors, ac-22kw one.
      expect(byId.CP001.connectors).toBe(1);
      expect(byId.DC004.connectors).toBe(2);
      // A line's override replaces a blueprint field for that charge point only.
      expect(byId.CP003.vendor).toBe("Acme");
      expect(byId.CP003.model).toBe("Flaky");
      expect(byId.CP001.vendor).not.toBe("Acme");

      // EV settings: the line replaces the built-in's.
      const ev = await cpRpc(socket, "DC004", "get_ev_settings", {
        connector: 1,
      });
      expect(ev.result.maxChargingPowerKw).toBe(99);
      // …while a line without them keeps the blueprint's.
      const evAc = await cpRpc(socket, "CP001", "get_ev_settings", {
        connector: 1,
      });
      expect(evAc.result.maxChargingPowerKw).not.toBe(99);

      // The line's scenario template replaces the blueprint's, on CP002 only.
      const scenarios2 = await cpRpc(socket, "CP002", "list_scenarios", {
        connector: 1,
      });
      expect(JSON.stringify(scenarios2.result)).toContain("smart-charging");
      const scenarios1 = await cpRpc(socket, "CP001", "list_scenarios", {
        connector: 1,
      });
      expect(JSON.stringify(scenarios1.result)).not.toContain("smart-charging");

      // Network simulation on CP003 only.
      const net3 = await rpc(socket, "network_sim.cp.get", { cpId: "CP003" });
      expect(net3.result.config?.seed).toBe(7);
      const net1 = await rpc(socket, "network_sim.cp.get", { cpId: "CP001" });
      expect(net1.result.config ?? null).toBeNull();
    } finally {
      socket.disconnect();
    }
  });

  it("does not mutate the referenced built-in blueprint", async () => {
    const server = await start();
    const socket = await connectTestClient(server);
    try {
      const before = (await rpc(socket, "blueprint.list", {})).result;
      await rpc(socket, "fleet.template.save", { template: LAB });
      await rpc(socket, "fleet.create", {
        templateId: "operations-lab",
        wsUrl: WS,
      });
      const after = (await rpc(socket, "blueprint.list", {})).result;
      expect(after).toEqual(before);
    } finally {
      socket.disconnect();
    }
  });

  it("leaves a running fleet alone when the template is edited or deleted", async () => {
    const server = await start();
    const socket = await connectTestClient(server);
    try {
      await rpc(socket, "fleet.template.save", { template: LAB });
      await rpc(socket, "fleet.create", {
        templateId: "operations-lab",
        wsUrl: WS,
      });
      await rpc(socket, "fleet.template.save", {
        template: {
          ...LAB,
          groups: [
            { name: "x", members: [{ cpId: "ZZ", blueprintId: "ac-22kw" }] },
          ],
        },
      });
      await rpc(socket, "fleet.template.delete", { id: LAB.id });
      expect((await cpList(socket)).map((c: any) => c.cpId).sort()).toEqual([
        "CP001",
        "CP002",
        "CP003",
        "DC004",
        "DC005",
      ]);
    } finally {
      socket.disconnect();
    }
  });

  it("reports a partial failure per charge point, in template order, keeping the rest", async () => {
    const server = await start();
    const socket = await connectTestClient(server);
    try {
      // An id that is only known to collide by trying.
      await rpc(socket, "cp.create", { cpId: "CP002", wsUrl: WS });
      await rpc(socket, "fleet.template.save", { template: LAB });
      const ack = await rpc(socket, "fleet.create", {
        templateId: "operations-lab",
        wsUrl: WS,
      });
      expect(ack.ok).toBe(true);
      expect(ack.result.created).toEqual(["CP001", "CP003", "DC004", "DC005"]);
      expect(ack.result.failed).toHaveLength(1);
      expect(ack.result.failed[0].cpId).toBe("CP002");
      expect(ack.result.failed[0].reason.length).toBeGreaterThan(0);
      // Running it again is deterministic: everything now collides.
      const again = await rpc(socket, "fleet.create", {
        templateId: "operations-lab",
        wsUrl: WS,
      });
      expect(again.result.created).toEqual([]);
      expect(again.result.failed.map((f: any) => f.cpId)).toEqual([
        "CP001",
        "CP002",
        "CP003",
        "DC004",
        "DC005",
      ]);
    } finally {
      socket.disconnect();
    }
  });

  it("creates nothing when the template cannot be resolved", async () => {
    const server = await start();
    const socket = await connectTestClient(server);
    try {
      const bad = (members: unknown[]) => ({
        id: "bad",
        name: "Bad",
        groups: [{ name: "g", members }],
      });
      const cases: Array<[unknown[], string]> = [
        [
          [
            { cpId: "A1", blueprintId: "ac-22kw" },
            { cpId: "A2", blueprintId: "no-such-blueprint" },
          ],
          "not_found",
        ],
        [
          [
            { cpId: "A1", blueprintId: "ac-22kw" },
            {
              cpId: "A2",
              blueprintId: "ac-22kw",
              scenarioTemplateId: "no-such-scenario",
            },
          ],
          "not_found",
        ],
        [
          [
            { cpId: "A1", blueprintId: "ac-22kw" },
            { idPattern: "A{n}", count: 2, blueprintId: "ac-22kw" },
          ],
          "invalid_params",
        ],
      ];
      for (const [members, code] of cases) {
        await rpc(socket, "fleet.template.save", { template: bad(members) });
        const ack = await rpc(socket, "fleet.create", {
          templateId: "bad",
          wsUrl: WS,
        });
        expect(ack.ok).toBe(false);
        expect(ack.error.code).toBe(code);
        expect(await cpList(socket)).toEqual([]);
      }
      // No wsUrl anywhere: the merged block is invalid, before any side effect.
      await rpc(socket, "fleet.template.save", {
        template: bad([{ cpId: "A1", blueprintId: "ac-22kw" }]),
      });
      const noUrl = await rpc(socket, "fleet.create", { templateId: "bad" });
      expect(noUrl.ok).toBe(false);
      expect(await cpList(socket)).toEqual([]);
      expect(
        (
          await rpc(socket, "fleet.create", {
            templateId: "missing",
            wsUrl: WS,
          })
        ).error.code,
      ).toBe("not_found");
    } finally {
      socket.disconnect();
    }
  });

  it("wsUrl precedence is the line, then the call, then the blueprint", async () => {
    const server = await start();
    const socket = await connectTestClient(server);
    try {
      await rpc(socket, "blueprint.save", {
        blueprint: {
          id: "with-url",
          name: "With URL",
          params: { wsUrl: "ws://blueprint.example/ocpp/" },
        },
      });
      await rpc(socket, "fleet.template.save", {
        template: {
          id: "urls",
          name: "URLs",
          groups: [
            {
              name: "g",
              members: [
                { cpId: "U1", blueprintId: "with-url" },
                {
                  cpId: "U2",
                  blueprintId: "with-url",
                  overrides: { wsUrl: "ws://line.example/ocpp/" },
                },
              ],
            },
          ],
        },
      });
      // Without a call URL the blueprint's is used: both create fine.
      const ack = await rpc(socket, "fleet.create", { templateId: "urls" });
      expect(ack.result.created).toEqual(["U1", "U2"]);
      expect(ack.result.failed).toEqual([]);
    } finally {
      socket.disconnect();
    }
  });

  it("creates nothing when a member's networkSimulation is not a valid layer config", async () => {
    const template = {
      id: "bad-net",
      name: "Bad network",
      groups: [
        {
          name: "g",
          members: [
            { cpId: "N1", blueprintId: "ac-22kw" },
            {
              cpId: "N2",
              blueprintId: "ac-22kw",
              networkSimulation: {
                enabled: true,
                rules: { r: { type: "no-such-rule-type" } },
              },
            },
          ],
        },
      ],
    };
    // Refused when saved, so it can never be stored…
    const plain = await start();
    const plainSocket = await connectTestClient(plain);
    try {
      const saved = await rpc(plainSocket, "fleet.template.save", {
        template,
      });
      expect(saved.ok).toBe(false);
      expect(saved.error.code).toBe("invalid_params");
      expect(saved.error.message).toContain('group "g", member 2');
    } finally {
      plainSocket.disconnect();
    }
    // …and a template that got in anyway (a row an older build stored) fails
    // `fleet.create` in the resolve step: nothing is created and rolled back.
    const server = await start({
      fleetTemplates: new FleetTemplateRepository(null, [
        template as FleetTemplate,
      ]),
    });
    const socket = await connectTestClient(server);
    const create = spyOn(server.registry, "create");
    try {
      const ack = await rpc(socket, "fleet.create", {
        templateId: "bad-net",
        wsUrl: WS,
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");
      expect(await cpList(socket)).toEqual([]);
      // Not even created and rolled back.
      expect(create).not.toHaveBeenCalled();
    } finally {
      socket.disconnect();
    }
  });

  it("autoConnect precedence is the line, then the call, then the blueprint, then off", async () => {
    const server = await start();
    const socket = await connectTestClient(server);
    const dialled: string[] = [];
    const csms = Bun.serve({
      port: 0,
      hostname: LOOPBACK,
      fetch(req) {
        dialled.push(new URL(req.url).pathname);
        return new Response("no", { status: 400 });
      },
    });
    const url = `ws://127.0.0.1:${tcpPort(csms)}/ocpp/`;
    try {
      await rpc(socket, "blueprint.save", {
        blueprint: {
          id: "dials",
          name: "Dials",
          params: { autoConnect: true },
        },
      });
      await rpc(socket, "fleet.template.save", {
        template: {
          id: "ac",
          name: "AC",
          groups: [
            {
              name: "g",
              members: [{ cpId: "A1", blueprintId: "dials" }],
            },
          ],
        },
      });
      // The caller's explicit false beats what the blueprint saved.
      const off = await rpc(socket, "fleet.create", {
        templateId: "ac",
        wsUrl: url,
        autoConnect: false,
      });
      expect(off.result.created).toEqual(["A1"]);
      await new Promise((r) => setTimeout(r, 400));
      expect(dialled).toEqual([]);
      // Without a call value the blueprint's applies.
      const on = await rpc(socket, "fleet.create", {
        templateId: "ac",
        wsUrl: url,
        idPrefix: "b-",
      });
      expect(on.result.created).toEqual(["b-A1"]);
      const deadline = Date.now() + 5000;
      while (dialled.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(dialled.some((p) => p.endsWith("/b-A1"))).toBe(true);
      expect(
        dialled.some((p) => p.endsWith("/A1") && !p.endsWith("b-A1")),
      ).toBe(false);
    } finally {
      csms.stop(true);
      socket.disconnect();
    }
  });

  it("refuses a range whose SOAP callback URL expands past the length cap", async () => {
    const server = await start();
    const socket = await connectTestClient(server);
    try {
      const longPath = "x".repeat(2100);
      await rpc(socket, "blueprint.save", {
        blueprint: {
          id: "soap-long",
          name: "SOAP long",
          params: {
            ocppVersion: "1.6-soap",
            soapCallbackUrl: `http://cb.example/${longPath}/{n:03}/`,
          },
        },
      });
      await rpc(socket, "fleet.template.save", {
        template: {
          id: "soap-t",
          name: "SOAP",
          groups: [
            {
              name: "g",
              members: [
                { idPattern: "S{n:03}", count: 2, blueprintId: "soap-long" },
              ],
            },
          ],
        },
      });
      const ack = await rpc(socket, "fleet.create", {
        templateId: "soap-t",
        wsUrl: "http://csms.example/soap",
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");
      expect(await cpList(socket)).toEqual([]);
    } finally {
      socket.disconnect();
    }
  });

  it("idPrefix lets one template be instantiated twice", async () => {
    const server = await start();
    const socket = await connectTestClient(server);
    try {
      await rpc(socket, "fleet.template.save", { template: LAB });
      const a = await rpc(socket, "fleet.create", {
        templateId: "operations-lab",
        wsUrl: WS,
        idPrefix: "a-",
      });
      const b = await rpc(socket, "fleet.create", {
        templateId: "operations-lab",
        wsUrl: WS,
        idPrefix: "b-",
      });
      expect(a.result.failed).toEqual([]);
      expect(b.result.failed).toEqual([]);
      expect(a.result.created[0]).toBe("a-CP001");
      expect(await cpList(socket)).toHaveLength(10);
    } finally {
      socket.disconnect();
    }
  });

  it("rejects a template that breaks the schema", async () => {
    const server = await start();
    const socket = await connectTestClient(server);
    try {
      const both = await rpc(socket, "fleet.template.save", {
        template: {
          id: "x",
          name: "x",
          groups: [
            {
              name: "g",
              members: [
                { cpId: "A", idPattern: "A{n}", count: 1, blueprintId: "b" },
              ],
            },
          ],
        },
      });
      expect(both.ok).toBe(false);
      const dupGroups = await rpc(socket, "fleet.template.save", {
        template: {
          id: "x",
          name: "x",
          groups: [
            { name: "g", members: [{ cpId: "A", blueprintId: "b" }] },
            { name: "g", members: [{ cpId: "B", blueprintId: "b" }] },
          ],
        },
      });
      expect(dupGroups.ok).toBe(false);
    } finally {
      socket.disconnect();
    }
  });
});

describe("fleet templates persist and come from files (#445)", () => {
  it("survive a --state-db restart", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = await start({ database: db });
      const s1 = await connectTestClient(first);
      await rpc(s1, "fleet.template.save", { template: LAB });
      s1.disconnect();
      await first.close();
      servers.splice(servers.indexOf(first), 1);

      const second = await start({ database: db });
      const s2 = await connectTestClient(second);
      try {
        const ack = await rpc(s2, "fleet.template.get", { id: LAB.id });
        expect(ack.result).toEqual(LAB);
        const created = await rpc(s2, "fleet.create", {
          templateId: LAB.id,
          wsUrl: WS,
        });
        expect(created.result.failed).toEqual([]);
      } finally {
        s2.disconnect();
        await second.close();
        servers.splice(servers.indexOf(second), 1);
      }
    } finally {
      db.close();
    }
  });

  it("file templates are listed, win over a stored one, and are read-only", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const parsed = fleetTemplateSchema.parse(LAB);
      const repo = new FleetTemplateRepository(db, [parsed]);
      repo.save({ ...parsed, name: "stored copy" });
      repo.save({ ...parsed, id: "other" });
      expect(repo.list().map((t) => t.id)).toEqual(["operations-lab", "other"]);
      expect(repo.get("operations-lab")?.name).toBe("Operations lab");
      expect(repo.isProvided("operations-lab")).toBe(true);
      expect(repo.isProvided("other")).toBe(false);
      expect(repo.delete("operations-lab")).toBe(false);
      expect(repo.listStored().map((t) => t.id)).toEqual([
        "operations-lab",
        "other",
      ]);
    } finally {
      db.close();
    }
  });

  it("a malformed stored row is skipped, not fatal", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const repo = new FleetTemplateRepository(db);
      repo.save(fleetTemplateSchema.parse(LAB));
      db.run(
        "INSERT INTO fleet_templates (id, name, description, definition, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["shape", "Shape", null, JSON.stringify({ id: "shape" }), "t"],
      );
      expect(repo.list().map((t) => t.id)).toEqual(["operations-lab"]);
    } finally {
      db.close();
    }
  });
});
