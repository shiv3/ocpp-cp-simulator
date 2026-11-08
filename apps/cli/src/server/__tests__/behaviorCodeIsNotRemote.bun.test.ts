/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

/**
 * Behavior code is loaded from the operator's own command line and nowhere
 * else (docs/concepts/charger-engine.md, "Loading code"). Socket.IO, MCP and
 * OCPP carry data: a scenario that arrives over `load_scenario` with fields
 * that look like code is stored, or refused, and never run as code.
 */
const CP = "CPNOCODE";

const scenario = {
  id: "code-looking",
  name: "Looks like code",
  targetType: "connector",
  targetId: 1,
  trigger: { type: "manual" },
  enabled: true,
  nodes: [
    {
      id: "s",
      type: "start",
      position: { x: 0, y: 0 },
      data: {
        label: "S",
        code: "globalThis.__behaviorCodeRan = 'node.code'",
        main: "globalThis.__behaviorCodeRan = 'node.main'",
        import: "data:text/javascript,globalThis.__behaviorCodeRan='import'",
      },
    },
    { id: "e", type: "end", position: { x: 0, y: 1 }, data: { label: "E" } },
  ],
  edges: [{ id: "e1", source: "s", target: "e" }],
  // Fields a behavior would have; a scenario has no use for them.
  api: 1,
  onCall: { UpdateFirmware: { mode: "replace", handle: "return {}" } },
  main: "globalThis.__behaviorCodeRan = 'scenario.main'",
  behavior: "export default { api: 1, id: 'smuggled' }",
  createdAt: "2026-07-30T00:00:00Z",
  updatedAt: "2026-07-30T00:00:00Z",
};

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

function rpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(5_000).emitWithAck("rpc", request);
}

describe("code-like data over the control plane", () => {
  it("load_scenario treats it as data and loads no behavior", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      server.registry.create(
        {
          cpId: CP,
          wsUrl: "ws://127.0.0.1:65534/never",
          connectors: 1,
          vendor: "test",
          model: "test",
          basicAuth: null,
        },
        { seedDefault: false },
      );
      const ack = await rpc(socket, {
        cpId: CP,
        method: "load_scenario",
        params: { connector: 1, scenario },
      });
      // Stored as data or refused as invalid: either way nothing ran.
      if (ack.ok) {
        const run = await rpc(socket, {
          cpId: CP,
          method: "run_scenario",
          params: { connector: 1, scenarioId: "code-looking" },
        });
        expect(typeof run.ok).toBe("boolean");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((globalThis as any).__behaviorCodeRan).toBeUndefined();
      const cp = (server.registry.get(CP) as any)._chargePoint;
      expect(cp.engine.behaviorIds).toEqual([]);
    } finally {
      socket.disconnect();
    }
  });

  it("has no RPC method that loads a behavior", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      for (const method of ["load_behavior", "behavior.load", "loadBehavior"]) {
        const ack = await rpc(socket, {
          cpId: CP,
          method,
          params: { source: "export default { api: 1, id: 'x' }" },
        });
        expect(ack.ok).toBe(false);
      }
    } finally {
      socket.disconnect();
    }
  });
});
