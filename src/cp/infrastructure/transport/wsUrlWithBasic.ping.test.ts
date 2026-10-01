import { afterEach, describe, it } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { openOcppWebSocket } from "./wsUrlWithBasic";

// #406: the socket openOcppWebSocket hands back must be able to send a real
// ping frame. Under Node (vitest) that is the `ws`-backed wrapper.

describe("openOcppWebSocket ping (#406)", () => {
  let server: WebSocketServer | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    server = null;
  });

  it("sends a ping frame the CSMS receives", async () => {
    server = new WebSocketServer({ port: 0 });
    const pinged = new Promise<void>((resolve) => {
      server!.on("connection", (conn) => conn.on("ping", () => resolve()));
    });
    const { port } = server.address() as AddressInfo;

    const socket = openOcppWebSocket({
      baseUrl: `ws://127.0.0.1:${port}/ocpp`,
      chargePointId: "CP-PING",
      basicAuth: null,
      onopen: () => socket.ping(),
    });

    await pinged;
    socket.close();
  });
});
