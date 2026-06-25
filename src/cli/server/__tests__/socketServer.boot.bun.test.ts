import { afterEach, describe, expect, it } from "bun:test";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

describe("socket.io server boot", () => {
  it("accepts a socket.io client and serves minimal healthz", async () => {
    const server = await startTestServer();
    servers.push(server);

    const socket = await connectTestClient(server);
    try {
      expect(socket.connected).toBe(true);

      const res = await fetch(`${server.url}/v1/healthz`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
      expect(Object.prototype.hasOwnProperty.call(body, "cps")).toBe(false);
    } finally {
      socket.disconnect();
    }
  });
});
