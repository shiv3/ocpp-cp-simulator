/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

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

describe("socket.io rpc dispatch", () => {
  it("returns redacted status for a CP command", async () => {
    const server = await serverWithCp();
    const socket = await connectTestClient(server);
    try {
      const ack = await emitRpc(socket, {
        cpId: "cp-alpha",
        method: "status",
        params: {},
      });

      expect(ack.ok).toBe(true);
      expect(ack.result.config.basicAuth).toEqual({ username: "user" });
      expect("password" in ack.result.config.basicAuth).toBe(false);
      expect(JSON.stringify(ack.result)).not.toContain("secret");
    } finally {
      socket.disconnect();
    }
  });

  it("returns not_found for an unknown method", async () => {
    const server = await serverWithCp();
    const socket = await connectTestClient(server);
    try {
      const ack = await emitRpc(socket, {
        method: "definitely_missing",
        params: {},
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("not_found");
    } finally {
      socket.disconnect();
    }
  });

  it("returns invalid_params for bad method params", async () => {
    const server = await serverWithCp();
    const socket = await connectTestClient(server);
    try {
      const ack = await emitRpc(socket, {
        cpId: "cp-alpha",
        method: "set_soc_meter_sync",
        params: { connector: 1 },
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");
    } finally {
      socket.disconnect();
    }
  });

  it("returns redacted cp.list items", async () => {
    const server = await serverWithCp();
    const socket = await connectTestClient(server);
    try {
      const ack = await emitRpc(socket, {
        method: "cp.list",
        params: {},
      });

      expect(ack.ok).toBe(true);
      expect(ack.result).toHaveLength(1);
      expect(ack.result[0].cpId).toBe("cp-alpha");
      expect(ack.result[0].basicAuth).toEqual({ username: "user" });
      expect("password" in ack.result[0].basicAuth).toBe(false);
      expect(ack.result[0].wsUrl).toBe("ws://example.test/ocpp");
      expect(JSON.stringify(ack.result)).not.toContain("secret");
    } finally {
      socket.disconnect();
    }
  });

  it("dispatches set_soc_meter_sync through jsonMode", async () => {
    const server = await serverWithCp();
    const socket = await connectTestClient(server);
    try {
      const ack = await emitRpc(socket, {
        cpId: "cp-alpha",
        method: "set_soc_meter_sync",
        params: { connector: 1, enabled: true },
      });
      expect(ack.ok).toBe(true);
    } finally {
      socket.disconnect();
    }
  });

  it("requires cpId for CP-command rpc methods", async () => {
    const server = await serverWithCp();
    const socket = await connectTestClient(server);
    try {
      const ack = await emitRpc(socket, {
        method: "status",
        params: {},
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("not_found");
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

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(2_000).emitWithAck("rpc", request);
}
