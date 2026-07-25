/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import { NetworkSimManager } from "../NetworkSimManager";
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

describe("network_sim RPC dispatch", () => {
  it("network_sim.global.get returns null initially", async () => {
    const server = await startTestServer();
    servers.push(server);

    // Wire the NetworkSimManager to the registry
    const manager = new NetworkSimManager(null, {
      listLiveWsCpIds: () => server.registry.liveWsCpIds(),
      applyToCp: () => {},
      triggerCpDisconnect: () => ({ ok: false, error: "sim_disabled" }),
    });
    server.registry.setNetworkSimManager(manager);

    const socket = await connectTestClient(server);
    try {
      const ack = await emitRpc(socket, {
        method: "network_sim.global.get",
        params: {},
      });

      expect(ack.ok).toBe(true);
      expect(ack.result.config).toBe(null);
    } finally {
      socket.disconnect();
    }
  });

  it("network_sim.global.save and get persist config", async () => {
    const server = await startTestServer();
    servers.push(server);

    const manager = new NetworkSimManager(null, {
      listLiveWsCpIds: () => server.registry.liveWsCpIds(),
      applyToCp: () => {},
      triggerCpDisconnect: () => ({ ok: false, error: "sim_disabled" }),
    });
    server.registry.setNetworkSimManager(manager);

    const socket = await connectTestClient(server);
    try {
      const config = {
        enabled: true,
        seed: 12345,
        rules: {
          "latency-rule": {
            type: "latency" as const,
            delayMs: 100,
          },
        },
      };

      const saveAck = await emitRpc(socket, {
        method: "network_sim.global.save",
        params: { config },
      });
      expect(saveAck.ok).toBe(true);

      const getAck = await emitRpc(socket, {
        method: "network_sim.global.get",
        params: {},
      });
      expect(getAck.ok).toBe(true);
      expect(getAck.result.config).toEqual(config);
    } finally {
      socket.disconnect();
    }
  });

  it("network_sim.global.save with null deletes config", async () => {
    const server = await startTestServer();
    servers.push(server);

    const manager = new NetworkSimManager(null, {
      listLiveWsCpIds: () => server.registry.liveWsCpIds(),
      applyToCp: () => {},
      triggerCpDisconnect: () => ({ ok: false, error: "sim_disabled" }),
    });
    server.registry.setNetworkSimManager(manager);

    const socket = await connectTestClient(server);
    try {
      const config = {
        enabled: true,
        seed: 12345,
        rules: {
          "latency-rule": {
            type: "latency" as const,
            delayMs: 100,
          },
        },
      };

      // Save a config
      await emitRpc(socket, {
        method: "network_sim.global.save",
        params: { config },
      });

      // Delete it with null
      const deleteAck = await emitRpc(socket, {
        method: "network_sim.global.save",
        params: { config: null },
      });
      expect(deleteAck.ok).toBe(true);

      // Verify it's gone
      const getAck = await emitRpc(socket, {
        method: "network_sim.global.get",
        params: {},
      });
      expect(getAck.ok).toBe(true);
      expect(getAck.result.config).toBe(null);
    } finally {
      socket.disconnect();
    }
  });

  it("network_sim.global.save with invalid config throws invalid_params", async () => {
    const server = await startTestServer();
    servers.push(server);

    const manager = new NetworkSimManager(null, {
      listLiveWsCpIds: () => server.registry.liveWsCpIds(),
      applyToCp: () => {},
      triggerCpDisconnect: () => ({ ok: false, error: "sim_disabled" }),
    });
    server.registry.setNetworkSimManager(manager);

    const socket = await connectTestClient(server);
    try {
      const ack = await emitRpc(socket, {
        method: "network_sim.global.save",
        params: {
          config: {
            enabled: true,
            rules: {
              "bad-rule": { type: "invalid-type" },
            },
          },
        },
      });

      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");
    } finally {
      socket.disconnect();
    }
  });

  it("network_sim.cp.get returns config and resolved for a CP", async () => {
    const server = await serverWithCp();
    const socket = await connectTestClient(server);
    try {
      const ack = await emitRpc(socket, {
        method: "network_sim.cp.get",
        params: { cpId: "cp-alpha" },
      });

      expect(ack.ok).toBe(true);
      expect(ack.result.config).toBe(null);
      expect(ack.result.resolved).toBeDefined();
      expect(ack.result.resolved.enabled).toBe(false);
      expect(ack.result.resolved.rules).toBeDefined();
    } finally {
      socket.disconnect();
    }
  });

  it("network_sim.cp.save persists per-CP config", async () => {
    const server = await serverWithCp();
    const socket = await connectTestClient(server);
    try {
      const config = {
        enabled: true,
        seed: 54321,
        rules: {
          "cp-latency": {
            type: "latency" as const,
            delayMs: 50,
          },
        },
      };

      const saveAck = await emitRpc(socket, {
        method: "network_sim.cp.save",
        params: { cpId: "cp-alpha", config },
      });
      expect(saveAck.ok).toBe(true);

      const getAck = await emitRpc(socket, {
        method: "network_sim.cp.get",
        params: { cpId: "cp-alpha" },
      });
      expect(getAck.ok).toBe(true);
      expect(getAck.result.config).toEqual(config);
    } finally {
      socket.disconnect();
    }
  });

  it("network_sim.cp.save with null deletes per-CP config", async () => {
    const server = await serverWithCp();
    const socket = await connectTestClient(server);
    try {
      const config = {
        enabled: true,
        seed: 54321,
        rules: {
          "cp-latency": {
            type: "latency" as const,
            delayMs: 50,
          },
        },
      };

      // Save a config
      await emitRpc(socket, {
        method: "network_sim.cp.save",
        params: { cpId: "cp-alpha", config },
      });

      // Delete it with null
      const deleteAck = await emitRpc(socket, {
        method: "network_sim.cp.save",
        params: { cpId: "cp-alpha", config: null },
      });
      expect(deleteAck.ok).toBe(true);

      // Verify it's gone
      const getAck = await emitRpc(socket, {
        method: "network_sim.cp.get",
        params: { cpId: "cp-alpha" },
      });
      expect(getAck.ok).toBe(true);
      expect(getAck.result.config).toBe(null);
    } finally {
      socket.disconnect();
    }
  });

  it("network_sim.disconnect.trigger returns cp_not_found for unknown CP", async () => {
    const server = await serverWithCp();
    const socket = await connectTestClient(server);
    try {
      const ack = await emitRpc(socket, {
        method: "network_sim.disconnect.trigger",
        params: { cpId: "unknown-cp", ruleId: "rule1" },
      });

      expect(ack.ok).toBe(true);
      expect(ack.result.ok).toBe(false);
      expect(ack.result.error).toBe("cp_not_found");
    } finally {
      socket.disconnect();
    }
  });

  it("network_sim.disconnect.trigger delegates to manager for live CP", async () => {
    const server = await serverWithCp();

    let triggerCalled = false;
    let triggerCpId = "";
    let triggerRuleId = "";

    const manager = new NetworkSimManager(null, {
      listLiveWsCpIds: () => server.registry.liveWsCpIds(),
      applyToCp: () => {},
      triggerCpDisconnect: (cpId: string, ruleId: string) => {
        triggerCalled = true;
        triggerCpId = cpId;
        triggerRuleId = ruleId;
        return { ok: false, error: "rule_not_manual" };
      },
    });
    server.registry.setNetworkSimManager(manager);

    const socket = await connectTestClient(server);
    try {
      const ack = await emitRpc(socket, {
        method: "network_sim.disconnect.trigger",
        params: { cpId: "cp-alpha", ruleId: "test-rule" },
      });

      expect(ack.ok).toBe(true);
      expect(triggerCalled).toBe(true);
      expect(triggerCpId).toBe("cp-alpha");
      expect(triggerRuleId).toBe("test-rule");
      expect(ack.result.ok).toBe(false);
      expect(ack.result.error).toBe("rule_not_manual");
    } finally {
      socket.disconnect();
    }
  });
});

// Test helpers
async function serverWithCp(): Promise<TestServer> {
  const server = await startTestServer();
  servers.push(server);

  const manager = new NetworkSimManager(null, {
    listLiveWsCpIds: () => server.registry.liveWsCpIds(),
    applyToCp: () => {},
    triggerCpDisconnect: () => ({ ok: false, error: "sim_disabled" }),
  });
  server.registry.setNetworkSimManager(manager);

  const socket = await connectTestClient(server);
  const createAck: any = await new Promise((resolve) => {
    socket.emit(
      "rpc",
      {
        id: 0,
        method: "cp.create",
        params: {
          cpId: "cp-alpha",
          wsUrl: "ws://example.test/ocpp",
          connectors: 1,
          vendor: "TestVendor",
          model: "TestModel",
        },
      },
      resolve,
    );
  });

  if (!createAck.ok) {
    throw new Error(`Failed to create CP: ${createAck.error?.message}`);
  }
  socket.disconnect();
  return server;
}

function emitRpc(
  socket: Socket,
  request: { cpId?: string; method: string; params: Record<string, any> },
): Promise<any> {
  return new Promise((resolve) => {
    socket.emit("rpc", { id: 0, ...request }, resolve);
  });
}
