// The OCPP client on Node (#916): `openOcppWebSocket` takes the `ws` package
// path there (Node's global WebSocket cannot send handshake headers). Runs
// under vitest, i.e. on Node, against a local `ws` server.
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  buildOcppWebSocketConnectOptions,
  openOcppWebSocket,
  type OcppSocket,
} from "../wsUrlWithBasic";

const servers: WebSocketServer[] = [];
const sockets: OcppSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(
    servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))),
  );
});

async function csms(options: {
  verify?: (req: IncomingMessage) => boolean;
}): Promise<{ url: string; handshakes: IncomingMessage[] }> {
  const handshakes: IncomingMessage[] = [];
  const server = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    handleProtocols: (protocols) => [...protocols][0] ?? false,
    verifyClient: ({ req }, done) => {
      handshakes.push(req);
      if (options.verify && !options.verify(req)) done(false, 401);
      else done(true);
    },
  });
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (ws) => {
    ws.on("message", (data) => ws.send(`echo:${String(data)}`));
  });
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/ocpp`, handshakes };
}

describe("openOcppWebSocket on Node (ws package)", () => {
  it("chooses the ws path on Node", () => {
    expect(
      buildOcppWebSocketConnectOptions({
        baseUrl: "ws://h/ocpp",
        chargePointId: "CP1",
        basicAuth: null,
      }).useNodeWsFallback,
    ).toBe(true);
  });

  it("sends Basic auth, extra headers and the OCPP subprotocol on the handshake", async () => {
    const expected = `Basic ${Buffer.from("CP1:s3cret-pass").toString("base64")}`;
    const { url, handshakes } = await csms({
      verify: (req) => req.headers.authorization === expected,
    });

    const messages: string[] = [];
    const opened = await new Promise<boolean>((resolve) => {
      const socket = openOcppWebSocket({
        baseUrl: url,
        chargePointId: "CP1",
        basicAuth: { username: "CP1", password: "s3cret-pass" },
        extraHeaders: { "X-Route": "blue" },
        ocppVersion: "OCPP-2.0.1",
        onopen: () => {
          socket.send("hello");
        },
        onmessage: (event) => {
          messages.push(String(event.data));
          resolve(true);
        },
        onerror: () => resolve(false),
      });
      sockets.push(socket);
    });

    expect(opened).toBe(true);
    expect(messages).toEqual(["echo:hello"]);
    const req = handshakes[0]!;
    expect(req.url).toBe("/ocpp/CP1");
    expect(req.headers.authorization).toBe(expected);
    expect(req.headers["x-route"]).toBe("blue");
    expect(req.headers["sec-websocket-protocol"]).toBe("ocpp2.0.1");
  });

  it("reports a refused handshake (401) as a 1002 close with the status", async () => {
    const { url } = await csms({ verify: () => false });

    const result = await new Promise<{ close: CloseEvent; errors: Event[] }>(
      (resolve) => {
        const errors: Event[] = [];
        const socket = openOcppWebSocket({
          baseUrl: url,
          chargePointId: "CP1",
          basicAuth: { username: "CP1", password: "wrong" },
          onerror: (event) => errors.push(event),
          onclose: (close) => resolve({ close, errors }),
        });
        sockets.push(socket);
      },
    );

    expect(result.close.code).toBe(1002);
    expect(result.close.reason).toBe("Unexpected server response: 401");
    expect(result.errors).toContainEqual(
      expect.objectContaining({ httpStatus: 401 }),
    );
  });
});
