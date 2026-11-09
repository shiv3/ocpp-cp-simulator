/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

/** #612: `cp.config_keys.get` / `cp.config_keys.set` over the wire. */

const servers: TestServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  while (servers.length > 0) await servers.pop()?.close();
});

function rpc(
  socket: Socket,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  return socket.timeout(5_000).emitWithAck("rpc", { method, params });
}

const base = {
  wsUrl: "ws://127.0.0.1:65534/never",
  connectors: 1,
  vendor: "test",
  model: "test",
  basicAuth: null,
};

async function setup(): Promise<Socket> {
  const server = await startTestServer({ database: null });
  servers.push(server);
  server.registry.create({ ...base, cpId: "CP-16" }, { seedDefault: false });
  server.registry.create(
    { ...base, cpId: "CP-201", ocppVersion: "OCPP-2.0.1" } as any,
    { seedDefault: false },
  );
  const socket = await connectTestClient(server);
  sockets.push(socket);
  return socket;
}

describe("cp.config_keys.* (#612)", () => {
  it("reads and writes a 1.6 key", async () => {
    const socket = await setup();
    const set = await rpc(socket, "cp.config_keys.set", {
      cpId: "CP-16",
      key: "HeartbeatInterval",
      value: "123",
    });
    expect(set).toMatchObject({
      ok: true,
      result: { key: "HeartbeatInterval", status: "Accepted" },
    });
    const get = await rpc(socket, "cp.config_keys.get", {
      cpId: "CP-16",
      keys: ["HeartbeatInterval", "Nope"],
    });
    expect(get.ok).toBe(true);
    expect(get.result.keys).toEqual([
      expect.objectContaining({ key: "HeartbeatInterval", value: "123" }),
    ]);
    expect(get.result.unknown).toEqual(["Nope"]);
  });

  it("answers not_found for an unknown key and an unknown charge point", async () => {
    const socket = await setup();
    const unknownKey = await rpc(socket, "cp.config_keys.set", {
      cpId: "CP-16",
      key: "NoSuchKey",
      value: "1",
    });
    expect(unknownKey).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    const unknownCp = await rpc(socket, "cp.config_keys.get", { cpId: "nope" });
    expect(unknownCp).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("answers invalid_params for a read-only key and a refused value", async () => {
    const socket = await setup();
    const readOnly = await rpc(socket, "cp.config_keys.set", {
      cpId: "CP-16",
      key: "GetConfigurationMaxKeys",
      value: "1",
    });
    expect(readOnly).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    const refused = await rpc(socket, "cp.config_keys.set", {
      cpId: "CP-16",
      key: "HeartbeatInterval",
      value: "abc",
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
  });

  it("goes through the Device Model for a 2.x charge point", async () => {
    const socket = await setup();
    const get = await rpc(socket, "cp.config_keys.get", { cpId: "CP-201" });
    expect(get.ok).toBe(true);
    expect(get.result.keys.every((k: any) => k.component && k.mutability)).toBe(
      true,
    );
    const roKey = get.result.keys.find((k: any) => k.mutability === "ReadOnly");
    expect(roKey).toBeDefined();
    const ro = await rpc(socket, "cp.config_keys.set", {
      cpId: "CP-201",
      key: roKey.key,
      value: "1",
    });
    expect(ro).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    // A store key outside the Device Model is not part of the station.
    const hidden = await rpc(socket, "cp.config_keys.set", {
      cpId: "CP-201",
      key: "GetConfigurationMaxKeys",
      value: "1",
    });
    expect(hidden).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("rejects malformed params", async () => {
    const socket = await setup();
    const ack = await rpc(socket, "cp.config_keys.set", { cpId: "CP-16" });
    expect(ack).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });
});
