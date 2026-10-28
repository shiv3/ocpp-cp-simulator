/* eslint-disable @typescript-eslint/no-explicit-any -- test ack payloads */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Socket } from "socket.io-client";

import {
  startMockCsms,
  type MockCsms,
} from "../../../cp/infrastructure/transport/__tests__/mockCsms";
import { tcpPort } from "../../../test/bunServe";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

// The per-CP `reset` RPC, and `cp.bulk` (#470): a lifecycle action on every
// charge point a label selector matches.

const servers: TestServer[] = [];
const sockets: Socket[] = [];
const csmsList: MockCsms[] = [];

afterEach(async () => {
  while (sockets.length > 0) sockets.pop()?.disconnect();
  while (servers.length > 0) await servers.pop()?.close();
  while (csmsList.length > 0) await csmsList.pop()?.stop();
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

describe("cp.bulk on a label selector (#470)", () => {
  async function fleet() {
    const { server, socket } = await client();
    const labelled: Array<[string, Record<string, string> | undefined]> = [
      ["A", { site: "s1", env: "lab" }],
      ["B", { site: "s1", env: "prod" }],
      ["C", { site: "s2", env: "lab" }],
      ["D", undefined],
    ];
    for (const [cpId, labels] of labelled) {
      const ack = await rpc(socket, "cp.create", { ...BASE, cpId, labels });
      expect(ack.ok).toBe(true);
    }
    return { server, socket };
  }

  function spyOnAction(
    server: TestServer,
    action: "disconnect" | "reset",
  ): Map<string, ReturnType<typeof spyOn>> {
    return new Map(
      server.registry
        .list()
        .map((cpId) => [cpId, spyOn(server.registry.get(cpId)!, action)]),
    );
  }

  it.each(["disconnect", "reset"] as const)(
    "%s acts on the matching charge points only",
    async (action) => {
      const { server, socket } = await fleet();
      const spies = spyOnAction(server, action);

      const ack = await rpc(socket, "cp.bulk", {
        labels: { site: "s1" },
        action,
      });

      expect(ack.ok).toBe(true);
      expect(ack.result).toEqual({
        matched: ["A", "B"],
        succeeded: ["A", "B"],
        failed: [],
      });
      expect(spies.get("A")).toHaveBeenCalledTimes(1);
      expect(spies.get("B")).toHaveBeenCalledTimes(1);
      expect(spies.get("C")).not.toHaveBeenCalled();
      expect(spies.get("D")).not.toHaveBeenCalled();
    },
  );

  it("answers an empty report, not an error, when nothing matches", async () => {
    const { server, socket } = await fleet();
    const spies = spyOnAction(server, "reset");

    const ack = await rpc(socket, "cp.bulk", {
      labels: { site: "nowhere" },
      action: "reset",
    });

    expect(ack.ok).toBe(true);
    expect(ack.result).toEqual({ matched: [], succeeded: [], failed: [] });
    for (const spy of spies.values()) expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty selector", { labels: {}, action: "reset" }],
    ["a missing selector", { action: "reset" }],
    ["an unknown action", { labels: { site: "s1" }, action: "delete" }],
    [
      "a cpId in params",
      { labels: { site: "s1" }, action: "reset", cpId: "A" },
    ],
  ])("refuses %s before acting", async (_case, params) => {
    const { server, socket } = await fleet();
    const spies = spyOnAction(server, "reset");

    const ack = await rpc(socket, "cp.bulk", params);

    expect(ack.ok).toBe(false);
    expect(ack.error.code).toBe("invalid_params");
    for (const spy of spies.values()) expect(spy).not.toHaveBeenCalled();
  });

  it("selects on the labels an in-place relabel set, in cp.bulk and cp.list alike", async () => {
    const { server, socket } = await fleet();
    const relabel = await rpc(socket, "cp.labels.set", {
      cpId: "A",
      labels: { site: "s9" },
    });
    expect(relabel.ok).toBe(true);
    const spies = spyOnAction(server, "reset");

    const moved = await rpc(socket, "cp.bulk", {
      labels: { site: "s9" },
      action: "reset",
    });
    const stayed = await rpc(socket, "cp.bulk", {
      labels: { site: "s1" },
      action: "reset",
    });
    const listed = await rpc(socket, "cp.list", { labels: { site: "s9" } });

    expect(moved.result.matched).toEqual(["A"]);
    expect(stayed.result.matched).toEqual(["B"]);
    expect(listed.result.map((cp: any) => cp.cpId)).toEqual(["A"]);
    expect(spies.get("A")).toHaveBeenCalledTimes(1);
    expect(spies.get("B")).toHaveBeenCalledTimes(1);
  });

  it("reports a refused connect next to a successful one", async () => {
    const csms = startMockCsms();
    csmsList.push(csms);
    const { socket } = await client();
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
    const closedPort = tcpPort(closed);
    await closed.stop(true);
    await rpc(socket, "cp.create", {
      ...BASE,
      wsUrl: csms.url,
      cpId: "UP",
      labels: { site: "s1" },
    });
    await rpc(socket, "cp.create", {
      ...BASE,
      wsUrl: `ws://127.0.0.1:${closedPort}/`,
      cpId: "DOWN",
      labels: { site: "s1" },
    });

    const ack = await rpc(socket, "cp.bulk", {
      labels: { site: "s1" },
      action: "connect",
    });

    expect(ack.ok).toBe(true);
    expect(ack.result.matched).toEqual(["UP", "DOWN"]);
    expect(ack.result.succeeded).toEqual(["UP"]);
    expect(ack.result.failed).toHaveLength(1);
    expect(ack.result.failed[0].cpId).toBe("DOWN");
    expect(ack.result.failed[0].reason).not.toBe("");
    expect(csms.openCount()).toBe(1);
  });
});
