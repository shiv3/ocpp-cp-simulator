/* eslint-disable @typescript-eslint/no-explicit-any -- test ack payloads */
// Runs under `bun test`: a real daemon, driven over Socket.IO.
import { afterEach, describe, expect, it } from "bun:test";

import { InvalidAuthorizationCacheSeedError } from "../../../cp/domain/auth/AuthorizationCacheSeed";
import { classifyFacadeError } from "../socketServer";
import { startServer, type RunningServer } from "../startServer";
import { connectTestClient } from "./socketHarness";

/**
 * #452: the Authorization Cache test seam over the control plane, and the
 * MCP tools that wrap it. Seed and clear act whatever the cache switch
 * says; nothing reaches the CSMS (the charge point is never connected).
 */

const BASE_OPTIONS = {
  httpHost: "127.0.0.1",
  pidPath: null,
  bootstrap: null,
  soapPath: "/ocpp/soap",
  autoConnect: false,
  startupScenario: null,
  cors: { kind: "any" } as const,
  staticDir: null,
  webConsolePort: null,
  healthPath: "/v1/healthz",
  webConsoleBasicAuth: null,
  insecureTlsKeyPerms: false,
  stateDb: null,
};

const CP = "CP-CACHE";

describe("authorization cache RPC (#452)", () => {
  const cleanups: Array<() => unknown> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function daemonWithOneCp(ocppVersion = "OCPP-1.6J") {
    const running: RunningServer = await startServer({
      ...BASE_OPTIONS,
      httpPort: 0,
    });
    cleanups.push(() => running.stop());
    const base = `http://127.0.0.1:${running.httpPort}`;
    const socket = await connectTestClient(base);
    cleanups.push(() => socket.disconnect());
    const rpc = (
      method: string,
      params: unknown,
      cpId?: string,
    ): Promise<any> =>
      new Promise((resolve) =>
        socket.emit(
          "rpc",
          { ...(cpId ? { cpId } : {}), method, params },
          resolve,
        ),
      );
    const created = await rpc("cp.create", {
      cpId: CP,
      wsUrl: "ws://example.test/ocpp/",
      connectors: 1,
      vendor: "V",
      model: "M",
      ocppVersion,
    });
    expect(created.ok).toBe(true);
    return { rpc, base };
  }

  it.each(["OCPP-1.6J", "OCPP-2.0.1"])(
    "%s: seeds, reads and clears the cache while it is disabled",
    async (version) => {
      const { rpc } = await daemonWithOneCp(version);
      expect(await rpc("get_auth_cache", {}, CP)).toEqual({
        id: undefined,
        ok: true,
        result: { enabled: false, entries: [] },
      });

      const seeded = await rpc(
        "seed_auth_cache",
        {
          entries: [
            {
              idToken: "TAG-1",
              status: "Accepted",
              expiresAt: "2099-01-01T00:00:00Z",
              parentId: "GROUP",
            },
            { idToken: "TAG-2", status: "Blocked" },
          ],
        },
        CP,
      );
      expect(seeded.result).toEqual({ seeded: 2 });

      const view = (await rpc("get_auth_cache", {}, CP)).result;
      expect(view.enabled).toBe(false);
      expect(
        view.entries.map((e: any) => [
          e.idToken,
          e.status,
          e.expiresAt,
          e.parentId,
        ]),
      ).toEqual([
        ["TAG-1", "Accepted", "2099-01-01T00:00:00.000Z", "GROUP"],
        ["TAG-2", "Blocked", undefined, undefined],
      ]);

      expect((await rpc("clear_auth_cache", {}, CP)).result).toEqual({
        cleared: true,
      });
      expect((await rpc("get_auth_cache", {}, CP)).result.entries).toEqual([]);
    },
  );

  it("drives the same seam through the MCP tools", async () => {
    const { base } = await daemonWithOneCp();
    let nextId = 1;
    const tool = async (name: string, args: unknown): Promise<any> => {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      const text = await response.text();
      const line = text.match(/^data: (.*)$/m)?.[1] ?? text;
      const message = JSON.parse(line);
      // Input the tool schema refuses is a JSON-RPC error, not a result.
      if (message.result === undefined) {
        return { isError: true, body: JSON.stringify(message.error) };
      }
      return {
        isError: message.result.isError === true,
        body: message.result.content[0].text,
      };
    };

    const seeded = await tool("auth_cache_seed", {
      cpId: CP,
      entries: [{ idToken: "TAG-M", status: "Expired" }],
    });
    expect(seeded.isError).toBe(false);
    expect(JSON.parse(seeded.body)).toEqual({ seeded: 1 });

    const view = await tool("auth_cache_get", { cpId: CP });
    expect(JSON.parse(view.body).entries[0]).toMatchObject({
      idToken: "TAG-M",
      status: "Expired",
    });

    const cleared = await tool("auth_cache_clear", { cpId: CP });
    expect(JSON.parse(cleared.body)).toEqual({ cleared: true });

    const refused = await tool("auth_cache_seed", {
      cpId: CP,
      entries: [{ idToken: "TAG-M", status: "Maybe" }],
    });
    expect(refused.isError).toBe(true);
  });

  it.each([
    ["an unknown status", [{ idToken: "T", status: "Maybe" }]],
    [
      "a duplicate idToken",
      [
        { idToken: "T", status: "Accepted" },
        { idToken: "T", status: "Blocked" },
      ],
    ],
    [
      "an unparseable expiry",
      [{ idToken: "T", status: "Accepted", expiresAt: "soon" }],
    ],
    ["an empty list", []],
  ])(
    "refuses %s with invalid_params and writes nothing",
    async (_l, entries) => {
      const { rpc } = await daemonWithOneCp();
      const ack = await rpc("seed_auth_cache", { entries }, CP);
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe("invalid_params");
      expect((await rpc("get_auth_cache", {}, CP)).result.entries).toEqual([]);
    },
  );

  it("answers not_found for an unknown charge point", async () => {
    const { rpc } = await daemonWithOneCp();
    const ack = await rpc("get_auth_cache", {}, "CP-NOPE");
    expect(ack.ok).toBe(false);
    expect(ack.error.code).toBe("not_found");
  });
});

describe("classifyFacadeError (#452)", () => {
  it("maps a refused cache seed to invalid_params", () => {
    // Over RPC zod refuses first; the Local adapter reaches the domain check.
    const failure = classifyFacadeError(
      new InvalidAuthorizationCacheSeedError("entries[0].idToken is empty"),
    );
    expect(failure?.code).toBe("invalid_params");
    expect(failure?.message).toBe("entries[0].idToken is empty");
  });
});
