/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import { subscribeResultSchema } from "../../../protocol";
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

describe("socket.io events.subscribe", () => {
  it("subscribes to registry and returns a redacted atomic snapshot", async () => {
    const server = await serverWithCp();
    const socket = await connectTestClient(server);
    try {
      const ack = await emitEvent(socket, "events.subscribe", {
        scope: "registry",
      });

      expect(subscribeResultSchema.safeParse(ack).success).toBe(true);
      expect(ack.subscribed).toEqual(["registry"]);
      expect(ack.snapshot.cps).toHaveLength(1);
      expect(ack.snapshot.cps[0].cpId).toBe("cp-alpha");
      expect(ack.snapshot.cps[0].basicAuth).toEqual({ username: "user" });
      expect("password" in ack.snapshot.cps[0].basicAuth).toBe(false);
      expect(ack.snapshot.perCp["cp-alpha"].config.basicAuth).toEqual({
        username: "user",
      });
      expect(
        "password" in ack.snapshot.perCp["cp-alpha"].config.basicAuth,
      ).toBe(false);
      expect(JSON.stringify(ack)).not.toContain("secret");
    } finally {
      socket.disconnect();
    }
  });

  it("rejects an unknown cpId scope", async () => {
    const server = await serverWithCp();
    const socket = await connectTestClient(server);
    try {
      const ack = await emitEvent(socket, "events.subscribe", {
        scope: "__nope__",
      });

      expect(errorCode(ack)).toBe("invalid_params");
    } finally {
      socket.disconnect();
    }
  });

  it("silently succeeds when unsubscribing an unknown scope", async () => {
    const server = await serverWithCp();
    const socket = await connectTestClient(server);
    try {
      const ack = await emitEvent(socket, "events.unsubscribe", {
        scope: "__nope__",
      });

      expect(ack).toEqual({ ok: true });
    } finally {
      socket.disconnect();
    }
  });
});

async function serverWithCp(): Promise<TestServer> {
  const server = await startTestServer();
  servers.push(server);
  server.registry.create(
    {
      cpId: "cp-alpha",
      wsUrl: "ws://user:secret@example.test/ocpp",
      connectors: 1,
      vendor: "TestVendor",
      model: "TestModel",
      basicAuth: { username: "user", password: "secret" },
      ocppVersion: "OCPP-1.6J",
    },
    { seedDefault: false },
  );
  return server;
}

function emitEvent(
  socket: Socket,
  event: string,
  request: unknown,
): Promise<any> {
  return socket.timeout(2_000).emitWithAck(event, request);
}

function errorCode(ack: any): string | undefined {
  return ack?.error?.code ?? ack?.code;
}
