/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Socket } from "socket.io-client";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

const servers: TestServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
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
      expect(ack.result.config.securityProfile).toBe(2);
      expect(ack.result.config.cpoName).toBe("Example CPO");
      expect(ack.result.config.tlsCaPath).toContain("ca.pem");
      expect("password" in ack.result.config.basicAuth).toBe(false);
      expect(JSON.stringify(ack.result)).not.toContain("secret");
      expect(JSON.stringify(ack.result)).not.toContain("AABBCC");
      expect(JSON.stringify(ack.result)).not.toContain("CA PEM");
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
      expect(ack.result[0].securityProfile).toBe(2);
      expect(ack.result[0].cpoName).toBe("Example CPO");
      expect(ack.result[0].tlsCaPath).toContain("ca.pem");
      expect("password" in ack.result[0].basicAuth).toBe(false);
      expect(ack.result[0].wsUrl).toBe("ws://example.test/ocpp");
      expect(JSON.stringify(ack.result)).not.toContain("secret");
      expect(JSON.stringify(ack.result)).not.toContain("AABBCC");
      expect(JSON.stringify(ack.result)).not.toContain("CA PEM");
    } finally {
      socket.disconnect();
    }
  });

  it("returns scenario templates without a CP", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      const ack = await emitRpc(socket, {
        method: "scenario.templates",
        params: {},
      });

      expect(ack.ok).toBe(true);
      expect(server.registry.list()).toHaveLength(0);
      expect(ack.result.length).toBeGreaterThan(0);
      expect(
        ack.result.map((template: { id: string }) => template.id),
      ).toContain("essential-cp-behavior");
    } finally {
      socket.disconnect();
    }
  });

  it("preserves security secrets and TLS material on redacted cp.update", async () => {
    const server = await serverWithCp();
    const socket = await connectTestClient(server);
    try {
      const ack = await emitRpc(socket, {
        method: "cp.update",
        params: {
          cpId: "cp-alpha",
          wsUrl: "ws://example.test/updated",
          connectors: 1,
          vendor: "UpdatedVendor",
          model: "UpdatedModel",
          basicAuth: { username: "user" },
        },
      });

      expect(ack.ok).toBe(true);
      const init = server.registry.get("cp-alpha")?.getInit();
      expect(init).toMatchObject({
        cpId: "cp-alpha",
        wsUrl: "ws://example.test/updated",
        vendor: "UpdatedVendor",
        model: "UpdatedModel",
        basicAuth: { username: "user", password: "secret" },
        securityProfile: 2,
        authorizationKey: "AABBCC",
        cpoName: "Example CPO",
        tls: { ca: "CA PEM" },
      });
      expect(init?.tlsCaPath).toContain("ca.pem");
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
  const tlsDir = mkdtempSync(resolve(tmpdir(), "ocpp-socket-rpc-tls-"));
  tempDirs.push(tlsDir);
  const tlsCaPath = resolve(tlsDir, "ca.pem");
  writeFileSync(tlsCaPath, "CA PEM");
  server.registry.create(
    {
      cpId: "cp-alpha",
      wsUrl: "ws://user:secret@example.test/ocpp",
      connectors: 1,
      vendor: "TestVendor",
      model: "TestModel",
      basicAuth: { username: "user", password: "secret" },
      ocppVersion: "OCPP-1.6J",
      securityProfile: 2,
      authorizationKey: "AABBCC",
      cpoName: "Example CPO",
      tls: { ca: "CA PEM" },
      tlsCaPath,
    },
    { seedDefault: false },
  );
  return server;
}

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(2_000).emitWithAck("rpc", request);
}
