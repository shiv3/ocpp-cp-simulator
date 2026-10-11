import { describe, expect, it, vi } from "vitest";

vi.mock("@socket.io/bun-engine", () => ({
  Server: class MockEngine {},
}));

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { buildServerInfo, registerSocketHandlers } from "../socketServer";
import {
  VehicleCatalogError,
  type CatalogVariant,
  type VehicleCatalog,
} from "../../../cp/domain/vehicle/VehicleCatalog";
import type { VehicleProfile } from "../../../cp/domain/vehicle/VehicleProfile";
import { OpenEvDirectoryClient } from "../../../cp/infrastructure/vehicle-catalog/open-ev-directory/OpenEvDirectoryClient";

type Handler = (...args: unknown[]) => void;
type RpcAck =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: { code: string; message: string; retryAfterSeconds?: number };
    };

class FakeIo {
  connectionHandler: Handler | null = null;
  readonly emitted: unknown[] = [];
  readonly use = vi.fn(() => this);
  readonly on = vi.fn((event: string, handler: Handler) => {
    if (event === "connection") this.connectionHandler = handler;
    return this;
  });
  readonly to = vi.fn(() => this);
  readonly emit = vi.fn((event: string, payload: unknown) => {
    this.emitted.push({ event, payload });
    return true;
  });
}

class FakeSocket {
  readonly handlers = new Map<string, Handler>();
  readonly handshake = { auth: {}, headers: {} };
  readonly join = vi.fn();
  readonly leave = vi.fn();
  readonly emitted: unknown[] = [];
  readonly emit = vi.fn((event: string, payload: unknown) => {
    this.emitted.push({ event, payload });
    return true;
  });
  readonly on = vi.fn((event: string, handler: Handler) => {
    this.handlers.set(event, handler);
    return this;
  });
  rpc(method: string, params: unknown = {}): Promise<RpcAck> {
    const handler = this.handlers.get("rpc");
    if (!handler) throw new Error("missing rpc handler");
    return new Promise((resolve) => handler({ method, params }, resolve));
  }
}

function connect(
  extra: {
    vehicleCatalog?: VehicleCatalog | null;
    serverInfo?: ReturnType<typeof buildServerInfo>;
  } = {},
) {
  const bus = new EventBus();
  const registry = new CPRegistry(bus, null);
  const io = new FakeIo();
  const socket = new FakeSocket();
  registerSocketHandlers(io as never, {
    registry,
    bus,
    database: null,
    ...extra,
  });
  if (!io.connectionHandler) throw new Error("missing connection handler");
  io.connectionHandler(socket);
  return { io, socket };
}

const PROFILE: VehicleProfile = {
  id: "vp_1",
  name: "Volkswagen ID.7 GTX",
  specs: {
    usableBatteryKwh: 86,
    acMaxKw: 11,
    acPhases: 3,
    dcMaxKw: 200,
    acConnectors: ["IEC_62196_T2"],
    dcConnectors: ["IEC_62196_T2_COMBO"],
  },
  dcCurve: [{ socPercent: 0, powerKw: 200 }],
  overrides: {},
  origin: null,
  createdAt: "2026-10-11T10:00:00.000Z",
  updatedAt: "2026-10-11T10:00:00.000Z",
};

const VARIANT: CatalogVariant = {
  id: "var_1",
  name: "ID.7 GTX",
  makeName: "Volkswagen",
  modelName: "ID.7",
  datasetVersion: "sha256:x",
  sourceRecords: [],
  curves: [],
};

function catalog(overrides: Partial<VehicleCatalog> = {}): VehicleCatalog {
  return {
    listMakes: vi.fn(async () => [
      { id: "volkswagen", name: "Volkswagen", modelCount: 3 },
    ]),
    searchModels: vi.fn(async () => ({
      items: [],
      page: 0,
      totalPages: 0,
      totalItems: 0,
    })),
    listVariants: vi.fn(async () => ({
      items: [],
      page: 0,
      totalPages: 0,
      totalItems: 0,
    })),
    getVariant: vi.fn(async () => VARIANT),
    ...overrides,
  };
}

describe("vehicle_profiles.* (#458)", () => {
  it("saves, lists and deletes a profile", async () => {
    const { socket } = connect();
    const saved = await socket.rpc("vehicle_profiles.save", {
      profile: PROFILE,
    });
    expect(saved).toEqual({ ok: true, result: PROFILE });
    expect(await socket.rpc("vehicle_profiles.list")).toEqual({
      ok: true,
      result: [PROFILE],
    });
    expect(await socket.rpc("vehicle_profiles.delete", { id: "vp_1" })).toEqual(
      { ok: true, result: { ok: true } },
    );
    expect(await socket.rpc("vehicle_profiles.list")).toEqual({
      ok: true,
      result: [],
    });
  });

  it("answers not_found for a profile that is not there", async () => {
    const { socket } = connect();
    const ack = await socket.rpc("vehicle_profiles.delete", { id: "nope" });
    expect(ack).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("refuses an invalid profile and an empty id", async () => {
    const { socket } = connect();
    expect(
      await socket.rpc("vehicle_profiles.save", {
        profile: { ...PROFILE, name: "" },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(
      await socket.rpc("vehicle_profiles.delete", { id: "" }),
    ).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  it("shares the store between connections", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const io = new FakeIo();
    registerSocketHandlers(io as never, { registry, bus, database: null });
    const a = new FakeSocket();
    const b = new FakeSocket();
    io.connectionHandler!(a);
    io.connectionHandler!(b);
    await a.rpc("vehicle_profiles.save", { profile: PROFILE });
    expect(await b.rpc("vehicle_profiles.list")).toEqual({
      ok: true,
      result: [PROFILE],
    });
  });
});

describe("vehicle_catalog.* (#458)", () => {
  it("relays the catalog", async () => {
    const vehicleCatalog = catalog();
    const { socket } = connect({ vehicleCatalog });
    expect(await socket.rpc("vehicle_catalog.list_makes")).toEqual({
      ok: true,
      result: [{ id: "volkswagen", name: "Volkswagen", modelCount: 3 }],
    });
    await socket.rpc("vehicle_catalog.search_models", {
      makeId: "volkswagen",
      model: "id.7",
      page: 1,
    });
    expect(vehicleCatalog.searchModels).toHaveBeenCalledWith({
      makeId: "volkswagen",
      model: "id.7",
      page: 1,
    });
    await socket.rpc("vehicle_catalog.list_variants", {
      modelId: "volkswagen--id-7",
    });
    expect(vehicleCatalog.listVariants).toHaveBeenCalledWith(
      "volkswagen--id-7",
      undefined,
    );
    expect(
      await socket.rpc("vehicle_catalog.get_variant", { variantId: "var_1" }),
    ).toEqual({ ok: true, result: VARIANT });
  });

  it("refuses an empty variant id", async () => {
    const { socket } = connect({ vehicleCatalog: catalog() });
    expect(
      await socket.rpc("vehicle_catalog.get_variant", { variantId: "" }),
    ).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  it("answers unavailable when no catalog is configured", async () => {
    const { socket } = connect();
    const ack = await socket.rpc("vehicle_catalog.list_makes");
    expect(ack).toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        message: expect.stringMatching(/--oed-base-url|OED_BASE_URL/),
      },
    });
  });

  const mapped: [VehicleCatalogError, string][] = [
    [new VehicleCatalogError("unauthorized", "refused"), "unauthorized"],
    [new VehicleCatalogError("not_found", "gone"), "not_found"],
    [new VehicleCatalogError("unavailable", "HTTP 503"), "unavailable"],
    [new VehicleCatalogError("network", "unreachable"), "unavailable"],
    [new VehicleCatalogError("invalid_response", "bad shape"), "unavailable"],
    [new VehicleCatalogError("not_configured", "no URL"), "unavailable"],
    [new VehicleCatalogError("timeout", "slow"), "timeout"],
    [new VehicleCatalogError("invalid_request", "bad param"), "invalid_params"],
  ];
  for (const [error, code] of mapped) {
    it(`maps a catalog ${error.kind} failure to ${code}, keeping its message`, async () => {
      const { socket } = connect({
        vehicleCatalog: catalog({
          getVariant: vi.fn(async () => {
            throw error;
          }),
        }),
      });
      const ack = await socket.rpc("vehicle_catalog.get_variant", {
        variantId: "var_1",
      });
      expect(ack).toEqual({
        ok: false,
        error: { code, message: error.message },
      });
    });
  }

  it("carries Retry-After of a rate-limited catalog", async () => {
    const { socket } = connect({
      vehicleCatalog: catalog({
        listMakes: vi.fn(async () => {
          throw new VehicleCatalogError("rate_limited", "slow down", {
            retryAfterSeconds: 30,
          });
        }),
      }),
    });
    expect(await socket.rpc("vehicle_catalog.list_makes")).toEqual({
      ok: false,
      error: {
        code: "rate_limited",
        message: "slow down",
        retryAfterSeconds: 30,
      },
    });
  });
});

describe("server.info.vehicleCatalog (#458)", () => {
  it("says whether a catalog and a key are set, never the key", async () => {
    const info = buildServerInfo({
      soapPublicBaseUrl: null,
      soapPath: "/soap",
      tunnel: null,
      vehicleCatalog: { configured: true, authenticated: true },
    });
    const { socket } = connect({ serverInfo: info });
    const ack = await socket.rpc("server.info");
    expect(ack).toMatchObject({
      ok: true,
      result: {
        vehicleCatalog: {
          provider: "open-ev-directory",
          configured: true,
          authenticated: true,
        },
      },
    });
  });
});

describe("the catalog API key never leaves the daemon (#458)", () => {
  const KEY = "evd_live_SENTINEL_9f8e7d6c5b4a";

  it("is in no ack, no socket frame and no log line, even when the API echoes it", async () => {
    const logged: unknown[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (level) =>
        vi
          .spyOn(console, level)
          .mockImplementation((...args: unknown[]) => logged.push(args)),
    );
    const vehicleCatalog = new OpenEvDirectoryClient({
      baseUrl: "https://evd.example.test",
      apiKey: KEY,
      fetch: async () =>
        new Response(
          JSON.stringify({ status: 401, detail: `key ${KEY} is revoked` }),
          {
            status: 401,
            headers: { "content-type": "application/problem+json" },
          },
        ),
    });
    const info = buildServerInfo({
      soapPublicBaseUrl: null,
      soapPath: "/soap",
      tunnel: null,
      vehicleCatalog: {
        configured: vehicleCatalog.configured,
        authenticated: vehicleCatalog.authenticated,
      },
    });
    const { io, socket } = connect({ vehicleCatalog, serverInfo: info });

    const acks = [
      await socket.rpc("vehicle_catalog.list_makes"),
      await socket.rpc("vehicle_catalog.get_variant", { variantId: "var_1" }),
      await socket.rpc("server.info"),
      await socket.rpc("vehicle_profiles.save", { profile: PROFILE }),
      await socket.rpc("vehicle_profiles.list"),
    ];
    expect(acks[0]).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
    const everything = JSON.stringify({
      acks,
      io: io.emitted,
      socket: socket.emitted,
      logged,
    });
    for (const spy of spies) spy.mockRestore();
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("SENTINEL");
  });
});
