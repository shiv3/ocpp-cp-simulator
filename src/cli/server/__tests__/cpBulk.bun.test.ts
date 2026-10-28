/* eslint-disable @typescript-eslint/no-explicit-any -- test ack payloads */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

// The per-CP `reset` RPC, and `cp.bulk` (#470): a lifecycle action on every
// charge point a label selector matches.

const servers: TestServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  while (sockets.length > 0) sockets.pop()?.disconnect();
  while (servers.length > 0) await servers.pop()?.close();
});

async function client() {
  const server = await startTestServer();
  servers.push(server);
  const socket = await connectTestClient(server);
  sockets.push(socket);
  return { server, socket };
}

function rpc(
  socket: Socket,
  method: string,
  params: unknown,
  cpId?: string,
): Promise<any> {
  return new Promise((resolve) =>
    socket.emit("rpc", { cpId, method, params }, resolve),
  );
}

const BASE = { wsUrl: "ws://example.test/ocpp/", connectors: 1 };

describe("per-CP reset RPC", () => {
  it("resets a registered charge point", async () => {
    const { socket } = await client();
    await rpc(socket, "cp.create", { ...BASE, cpId: "CP1" });
    const ack = await rpc(socket, "reset", {}, "CP1");
    expect(ack.ok).toBe(true);
  });

  it("answers not_found for an unknown charge point", async () => {
    const { socket } = await client();
    const ack = await rpc(socket, "reset", {}, "NOPE");
    expect(ack.ok).toBe(false);
    expect(ack.error.code).toBe("not_found");
  });
});
