import { afterEach, describe, expect, it, vi } from "vitest";
import { ChargePoint } from "../ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";
import type { Database, SqlParam, SqlRow } from "../../persistence/Database";
import { OCPPWebSocket } from "../../../infrastructure/transport/OCPPWebSocket";

// #406: WebSocketPingInterval reaches the transport, and a charge point
// that cannot send a ping frame does not claim the key.

function makeCp(
  ocppVersion = "OCPP-1.6J",
  database: Database | null = null,
): ChargePoint {
  return new ChargePoint(
    "cp-ping",
    DefaultBootNotification,
    1,
    "ws://localhost:8080",
    null,
    null,
    database,
    {},
    [],
    ocppVersion,
    {},
  );
}

/** Answers the configuration-override query and nothing else. */
class OverrideDatabase implements Database {
  constructor(private readonly overrides: Record<string, string>) {}
  exec(): void {}
  run(): void {}
  all<T = SqlRow>(sql: string, _params: SqlParam[] = []): T[] {
    if (!sql.includes("FROM configuration")) return [];
    return Object.entries(this.overrides).map(([key, value]) => ({
      key,
      value,
    })) as T[];
  }
  get<T = SqlRow>(): T | null {
    return null;
  }
  close(): void {}
}

describe("ChargePoint WebSocketPingInterval (#406)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["OCPP-1.6J", "OCPP-2.0.1", "OCPP-2.1"])(
    "%s: advertises the key with the spec default 0",
    (version) => {
      const cp = makeCp(version);
      expect(cp.configuration.get("WebSocketPingInterval")?.value).toBe(0);
      expect(cp.configuration.webSocketPingInterval()).toBe(0);
    },
  );

  it("forwards an accepted change to the transport", () => {
    const cp = makeCp();
    const setPingInterval = vi.spyOn(cp["_webSocket"]!, "setPingInterval");

    expect(cp.configuration.applyChange("WebSocketPingInterval", "5")).toBe(
      "Accepted",
    );
    expect(setPingInterval).toHaveBeenLastCalledWith(5);

    expect(cp.configuration.applyChange("WebSocketPingInterval", "0")).toBe(
      "Accepted",
    );
    expect(setPingInterval).toHaveBeenLastCalledWith(0);
  });

  it("rejects a negative interval, as §9.1.34 requires", () => {
    const cp = makeCp();
    const setPingInterval = vi.spyOn(cp["_webSocket"]!, "setPingInterval");

    expect(cp.configuration.applyChange("WebSocketPingInterval", "-1")).toBe(
      "Rejected",
    );
    expect(setPingInterval).not.toHaveBeenCalled();
    expect(cp.configuration.webSocketPingInterval()).toBe(0);
  });

  it("rejects an interval setInterval cannot hold (> 2^31-1 ms)", () => {
    const cp = makeCp();

    expect(
      cp.configuration.applyChange("WebSocketPingInterval", "2147483"),
    ).toBe("Accepted");
    expect(
      cp.configuration.applyChange("WebSocketPingInterval", "2147484"),
    ).toBe("Rejected");
    expect(cp.configuration.webSocketPingInterval()).toBe(2147483);
  });

  it("hands a persisted interval to the transport at construction", () => {
    const setPingInterval = vi.spyOn(
      OCPPWebSocket.prototype,
      "setPingInterval",
    );

    makeCp("OCPP-1.6J", new OverrideDatabase({ WebSocketPingInterval: "7" }));

    expect(setPingInterval).toHaveBeenLastCalledWith(7);
  });

  it("ignores a persisted interval outside the key's range", () => {
    // Written by a version that did not enforce the bound yet.
    const cp = makeCp(
      "OCPP-1.6J",
      new OverrideDatabase({ WebSocketPingInterval: "3000000" }),
    );

    expect(cp.configuration.webSocketPingInterval()).toBe(0);
  });

  it("SOAP charge point: the key is unknown, so a change is NotSupported", () => {
    const cp = makeCp("OCPP-1.6S");

    expect(cp.configuration.get("WebSocketPingInterval")).toBeUndefined();
    expect(cp.configuration.applyChange("WebSocketPingInterval", "5")).toBe(
      "NotSupported",
    );
  });

  it("runtime without ping frames (browser): the key is unknown", () => {
    vi.spyOn(OCPPWebSocket.prototype, "supportsPing", "get").mockReturnValue(
      false,
    );
    const cp = makeCp();

    expect(cp.configuration.get("WebSocketPingInterval")).toBeUndefined();
    expect(cp.configuration.applyChange("WebSocketPingInterval", "5")).toBe(
      "NotSupported",
    );
  });
});
