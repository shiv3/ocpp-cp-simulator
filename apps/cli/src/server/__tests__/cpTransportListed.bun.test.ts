/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

/**
 * #683 / #684 (review of PR #811): `status`, `cp.list` and `cp.get` return the
 * charge point's `transport`, with the proxy URL's credentials removed.
 */

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(2_000).emitWithAck("rpc", request);
}

describe("transport in cp.list / cp.get", () => {
  it("returns reconnect settings and a proxy without userinfo", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      const created = await emitRpc(socket, {
        method: "cp.create",
        params: {
          cpId: "CPT",
          wsUrl: "ws://127.0.0.1:65534/never",
          connectors: 1,
          vendor: "V",
          model: "M",
          ocppVersion: "OCPP-1.6J",
          transport: {
            reconnect: { mode: "fixed", baseDelayMs: 60000 },
            ws: { proxy: "http://puser:proxy-secret@proxy.test:3128" },
          },
        },
      });
      expect(created.ok).toBe(true);

      const expected = {
        reconnect: { mode: "fixed", baseDelayMs: 60000 },
        ws: { proxy: "http://proxy.test:3128/" },
      };
      const status = await emitRpc(socket, {
        cpId: "CPT",
        method: "status",
        params: {},
      });
      expect(status.result.config.transport).toEqual(expected);

      const list = await emitRpc(socket, { method: "cp.list", params: {} });
      const item = JSON.stringify(list.result);
      expect(item).not.toContain("proxy-secret");
      expect(
        (list.result.cps ?? list.result).find((c: any) => c.cpId === "CPT")
          .transport,
      ).toEqual(expected);
    } finally {
      socket.close();
    }
  });
});
