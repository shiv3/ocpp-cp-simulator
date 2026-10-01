import { describe, expect, expectTypeOf, it, vi } from "vitest";

vi.mock("@socket.io/bun-engine", () => ({
  Server: class MockEngine {},
}));

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createRuntimeDeps, errorCodeFrom, runRpc } from "../socketServer";
import { METHODS, type Params } from "../../../protocol";
import { STR_64K_MAX } from "../../../protocol/limits";
import {
  OcppCallNoAnswerError,
  OcppCallRejectedError,
} from "../../../cp/domain/errors/OcppCallErrors";

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

  // The handlers used to refuse these with `requireString` / `optionalString`
  // (answering `internal`); the schema refuses them now. An empty `tagId`
  // reaching the service would skip the idTag pool, since `resolveIdTag`
  // only falls back on a missing tag. Every field is listed in
  // src/protocol/__tests__/nonEmptyParams.test.ts.
  it.each([
    ["start_transaction", { connector: 1, tagId: "" }, "startTransaction"],
    ["authorize", { tagId: "" }, "authorize"],
    ["data_transfer", { vendorId: "" }, "sendDataTransfer"],
    ["run_scenario", { connector: 1, scenarioId: "" }, "runScenario"],
    ["run_scenario_file", { connector: 1, file: "" }, "runScenarioFile"],
  ])(
    "%s refuses an empty string as invalid_params and sends nothing",
    async (method, params, operation) => {
      const facade = {
        [operation]: vi.fn(),
        resolveIdTag: vi.fn((_id: string, tagId?: string) => tagId ?? "POOL"),
      };
      const error = await rpcError(facade, {
        cpId: "cp-alpha",
        method,
        params,
      });
      expect(error.code).toBe("invalid_params");
      expect(facade[operation]).not.toHaveBeenCalled();
    },
  );

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

describe("send_ocpp_call (#389)", () => {
  const outcome = {
    kind: "callError",
    messageId: "m1",
    sentFrame: '[2,"m1","Heartbeat",{}]',
    errorCode: "NotImplemented",
    errorDescription: "no",
    errorDetails: {},
  };

  it("passes the parsed request through and returns the CALLERROR as a result", async () => {
    const sendOcppCall = vi.fn().mockResolvedValue(outcome);
    await expect(
      runRpc(depsWith({ sendOcppCall }), {
        cpId: "cp-alpha",
        method: "send_ocpp_call",
        params: {
          action: "Heartbeat",
          payload: {},
          skipValidation: true,
          applyResponse: false,
        },
      }),
    ).resolves.toEqual(outcome);
    expect(sendOcppCall).toHaveBeenCalledWith("cp-alpha", {
      action: "Heartbeat",
      payload: {},
      skipValidation: true,
      applyResponse: false,
    });
  });

  it("refuses a payload that is not an object as invalid_params", async () => {
    const sendOcppCall = vi.fn();
    const error = await rpcError(
      { sendOcppCall },
      {
        cpId: "cp-alpha",
        method: "send_ocpp_call",
        params: { action: "Heartbeat", payload: [1] },
      },
    );
    expect(error.code).toBe("invalid_params");
    expect(sendOcppCall).not.toHaveBeenCalled();
  });

  it.each([
    [
      new OcppCallRejectedError(
        "unsupported_action",
        "Reset is not a station call",
      ),
      "invalid_params",
      "Reset is not a station call",
    ],
    [
      new OcppCallRejectedError("invalid_payload", "Outgoing Heartbeat failed"),
      "invalid_params",
      "Outgoing Heartbeat failed",
    ],
    [
      new OcppCallRejectedError("boot_gate", "blocked by the boot gate"),
      "invalid_params",
      "blocked by the boot gate",
    ],
    [new OcppCallNoAnswerError("timeout", "no answer"), "timeout", "no answer"],
    [
      new OcppCallNoAnswerError("dropped", "dropped (socket_closed)"),
      "disconnected",
      "dropped (socket_closed)",
    ],
  ])("maps %s to %s", async (thrown, code, message) => {
    const error = await rpcError(
      { sendOcppCall: vi.fn().mockRejectedValue(thrown) },
      {
        cpId: "cp-alpha",
        method: "send_ocpp_call",
        params: { action: "Heartbeat", payload: {} },
      },
    );
    expect(error).toEqual({ code, message });
  });
});
