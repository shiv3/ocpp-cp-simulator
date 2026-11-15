// The same proof as RpcEndpoint.test.ts over a real WebSocket (#978): a
// Bun.serve CSMS and a WebSocket charging station, each an RpcEndpoint built
// from ocpp-rpc and ocpp alone, exchanging an OCPP 1.6J BootNotification.
import { afterEach, expect, it } from "bun:test";

import {
  OCPP16_RPC_DIALECT,
  RpcEndpoint,
  ocppSchemaValidator,
} from "@ocpp-cp-simulator/ocpp-rpc/index";

// Bind to loopback explicitly, as the simulator's own tests do (#910): on
// macOS a wildcard listener can lose its port to another 127.0.0.1 bind. The
// simulator's LOOPBACK constant lives in core, which this package must not
// import.
const LOOPBACK = "127.0.0.1";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it("exchanges a 1.6J BootNotification over a real WebSocket", async () => {
  const validate = ocppSchemaValidator("1.6");
  let csmsSeen: unknown;
  const server = Bun.serve<{ endpoint: RpcEndpoint }>({
    hostname: LOOPBACK,
    port: 0,
    fetch(req, srv) {
      if (req.headers.get("sec-websocket-protocol") !== "ocpp1.6")
        return new Response("ocpp1.6 required", { status: 400 });
      return srv.upgrade(req, {
        headers: { "Sec-WebSocket-Protocol": "ocpp1.6" },
        data: { endpoint: undefined as unknown as RpcEndpoint },
      })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        let n = 0;
        ws.data.endpoint = new RpcEndpoint({
          dialect: OCPP16_RPC_DIALECT,
          validate,
          nextMessageId: () => `csms-${++n}`,
          send: (frame) => {
            ws.send(frame);
          },
        });
        ws.data.endpoint.handle("BootNotification", (payload) => {
          csmsSeen = payload;
          return {
            status: "Accepted",
            currentTime: "2026-11-15T10:00:00.000Z",
            interval: 300,
          };
        });
      },
      message(ws, message) {
        ws.data.endpoint.receive(String(message));
      },
      close(ws) {
        ws.data.endpoint.close("socket closed");
      },
    },
  });
  cleanups.push(() => void server.stop(true));

  const socket = new WebSocket(
    `ws://${LOOPBACK}:${server.port}/CP001`,
    "ocpp1.6",
  );
  cleanups.push(() => socket.close());
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("no connect")), {
      once: true,
    });
  });
  expect(socket.protocol).toBe("ocpp1.6");

  let n = 0;
  const cs = new RpcEndpoint({
    dialect: OCPP16_RPC_DIALECT,
    validate,
    callTimeoutMs: 5_000,
    nextMessageId: () => `cs-${++n}`,
    send: (frame) => socket.send(frame),
  });
  socket.addEventListener("message", (event) => cs.receive(String(event.data)));
  cleanups.push(() => cs.close());

  const boot = { chargePointVendor: "Vendor", chargePointModel: "Model" };
  await expect(cs.call("BootNotification", boot)).resolves.toEqual({
    status: "Accepted",
    currentTime: "2026-11-15T10:00:00.000Z",
    interval: 300,
  });
  expect(csmsSeen).toEqual(boot);
});
