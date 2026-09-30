import { describe, expect, expectTypeOf, it, vi } from "vitest";

vi.mock("@socket.io/bun-engine", () => ({
  Server: class MockEngine {},
}));

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createRuntimeDeps, errorCodeFrom, runRpc } from "../socketServer";
import { METHODS, type Params } from "../../../protocol";
import { STR_64K_MAX } from "../../../protocol/limits";

// #383: the zod schema in `METHODS` is the one narrowing step on the daemon
// path. These pin what that means at the edges: a schema-valid request is
// never refused by a second, drifting check, and a value the handlers cannot
// use is refused by the schema as `invalid_params` rather than `internal`.

function depsWith(facade: Record<string, unknown>) {
  const bus = new EventBus();
  return createRuntimeDeps({
    registry: new CPRegistry(bus, null),
    bus,
    database: null,
    chargePointService: facade as never,
  });
}

async function rpcError(
  facade: Record<string, unknown>,
  request: { cpId?: string; method: string; params?: unknown },
): Promise<{ code: string; message: string }> {
  try {
    await runRpc(depsWith(facade), request);
  } catch (err) {
    return {
      code: errorCodeFrom(err),
      message: err instanceof Error ? err.message : "",
    };
  }
  throw new Error(`${request.method} unexpectedly succeeded`);
}

describe("RPC params are narrowed by the schema alone (#383)", () => {
  it.each([
    ["a string at the schema's length cap", "x".repeat(STR_64K_MAX)],
    ["a string only JSON escaping would push past the cap", '"'.repeat(40_000)],
  ])("data_transfer accepts %s (#382)", async (_label, data) => {
    const sendDataTransfer = vi.fn().mockResolvedValue({ status: "Accepted" });

    await expect(
      runRpc(depsWith({ sendDataTransfer }), {
        cpId: "cp-alpha",
        method: "data_transfer",
        params: { vendorId: "acme", data },
      }),
    ).resolves.toEqual({ status: "Accepted" });
    expect(sendDataTransfer).toHaveBeenCalledWith(
      "cp-alpha",
      "acme",
      undefined,
      data,
    );
  });

  it("update_connector_status refuses a status outside the OCPP vocabulary as invalid_params", async () => {
    const sendStatusNotification = vi.fn();
    const error = await rpcError(
      { sendStatusNotification },
      {
        cpId: "cp-alpha",
        method: "update_connector_status",
        params: { connector: 1, status: "Sleeping" },
      },
    );
    expect(error.code).toBe("invalid_params");
    expect(sendStatusNotification).not.toHaveBeenCalled();
  });

  it("update_connector_status refuses an unparseable timestamp as invalid_params", async () => {
    const sendStatusNotification = vi.fn();
    const error = await rpcError(
      { sendStatusNotification },
      {
        cpId: "cp-alpha",
        method: "update_connector_status",
        params: { connector: 1, status: "Available", timestamp: "yesterday" },
      },
    );
    expect(error.code).toBe("invalid_params");
    expect(sendStatusNotification).not.toHaveBeenCalled();
  });

  it("update_connector_status passes a valid timestamp on as a Date", async () => {
    const sendStatusNotification = vi.fn().mockResolvedValue(undefined);
    await runRpc(depsWith({ sendStatusNotification }), {
      cpId: "cp-alpha",
      method: "update_connector_status",
      params: {
        connector: 0,
        status: "Available",
        timestamp: "2026-09-30T08:00:00.000Z",
        info: "boot",
      },
    });
    expect(sendStatusNotification).toHaveBeenCalledWith(
      "cp-alpha",
      0,
      "Available",
      { info: "boot", timestamp: new Date("2026-09-30T08:00:00.000Z") },
    );
  });

  it("set_mode refuses an unknown mode as invalid_params", async () => {
    const setConnectorMode = vi.fn();
    const error = await rpcError(
      { setConnectorMode },
      {
        cpId: "cp-alpha",
        method: "set_mode",
        params: { connector: 1, mode: "turbo" },
      },
    );
    expect(error.code).toBe("invalid_params");
    expect(setConnectorMode).not.toHaveBeenCalled();
  });

  it("load_scenario naming neither file nor scenario is invalid_params", async () => {
    const loadScenario = vi.fn();
    const error = await rpcError(
      { loadScenario },
      { cpId: "cp-alpha", method: "load_scenario", params: { connector: 1 } },
    );
    expect(error.code).toBe("invalid_params");
    expect(loadScenario).not.toHaveBeenCalled();
  });

  it.each([
    ["cp.delete", { cpId: "" }],
    ["logs.get", { cpId: "" }],
    ["logs.clear", { cpId: "" }],
    ["blueprint.delete", { id: "" }],
  ])("%s refuses an empty id as invalid_params", async (method, params) => {
    const error = await rpcError({}, { method, params });
    expect(error.code).toBe("invalid_params");
  });

  it("still names a cpId misplaced inside params, although the schema strips it (#286)", async () => {
    const error = await rpcError(
      {},
      { method: "status", params: { cpId: "cp-alpha" } },
    );
    expect(error.code).toBe("invalid_params");
    expect(error.message).toContain('inside "params"');
  });

  it("leaves an omitted optional cp.update field absent, so the stored secret is kept", () => {
    // `mergeUpdateParams` tells "omitted" from "cleared" with hasOwnProperty.
    const parsed = METHODS["cp.update"].params.parse({
      cpId: "cp-alpha",
      wsUrl: "ws://csms.example/ocpp",
    });
    expect(Object.prototype.hasOwnProperty.call(parsed, "basicAuth")).toBe(
      false,
    );
  });

  it("types each method's params from its schema", () => {
    expectTypeOf<
      Params<"start_transaction">["connector"]
    >().toEqualTypeOf<number>();
    expectTypeOf<Params<"logs.get">["order"]>().toEqualTypeOf<
      "asc" | "desc" | undefined
    >();
  });
});
