import { afterEach, describe, expect, it } from "bun:test";
import { createChargePoint } from "../../charge-point/createChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { startMockCsms, type MockCsms } from "./mockCsms";

/**
 * #1092 / #1093: what the station offers in the upgrade request (subprotocols,
 * headers, path) and the ping interval it starts with, seen from the CSMS.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("WebSocket handshake control (#1092, #1093)", () => {
  const cleanups: Array<() => unknown> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function connect(
    ws: Record<string, unknown>,
    id = "CP-HS",
    version = "OCPP-1.6J",
  ): Promise<MockCsms> {
    const csms = startMockCsms();
    cleanups.push(() => csms.stop());
    const cp = createChargePoint(
      id,
      DefaultBootNotification,
      1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      version,
      { ws },
    );
    cp.events.on("error", () => undefined);
    cleanups.push(() => cp.disconnect());
    cp.connect();
    await csms.waitForConnection(5000);
    return csms;
  }

  it("offers the version's subprotocol by default", async () => {
    const csms = await connect({});
    expect(csms.upgradeRequests[0].protocols).toBe("ocpp1.6");
    expect(csms.upgradeRequests[0].target).toEndWith("/CP-HS");
  });

  it("offers a custom list as given, several, or none", async () => {
    const several = await connect({ subprotocols: ["OCPP1.6", "ocpp2.0.1"] });
    expect(several.upgradeRequests[0].protocols).toBe("OCPP1.6, ocpp2.0.1");
    const none = await connect({ subprotocols: [] });
    expect(none.upgradeRequests[0].protocols).toBeNull();
  });

  it("sends extra headers and a raw path suffix and identity", async () => {
    const csms = await connect(
      {
        headers: { "X-Probe": "yes" },
        pathSuffix: "/extra?token=abc",
        chargePointIdEncoding: "raw",
      },
      "CP%2F7",
    );
    const request = csms.upgradeRequests[0];
    expect(request.headers["x-probe"]).toBe("yes");
    expect(request.target).toEndWith("/CP%2F7/extra?token=abc");
    const encoded = await connect({}, "CP%2F7");
    expect(encoded.upgradeRequests[0].target).toEndWith("/CP%252F7");
  });

  it("pingIntervalSeconds seeds WebSocketPingInterval and the client pings", async () => {
    const csms = await connect({ pingIntervalSeconds: 1 });
    const deadline = Date.now() + 5000;
    while ((csms.connections().at(-1)?.pings ?? 0) < 1) {
      if (Date.now() > deadline) throw new Error("no ping within 5 s");
      await sleep(50);
    }
    expect(csms.connections().at(-1)?.pings).toBeGreaterThanOrEqual(1);
  }, 10_000);
});
