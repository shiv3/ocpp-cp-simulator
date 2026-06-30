import { describe, expect, it, vi } from "vitest";

vi.mock("@socket.io/bun-engine", () => ({
  Server: class MockEngine {},
}));

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { registerSocketHandlers } from "../socketServer";

type Handler = (...args: unknown[]) => void;
type RpcAck = { ok: true; result: unknown } | { ok: false; error: unknown };

class FakeIo {
  connectionHandler: Handler | null = null;

  readonly use = vi.fn(() => this);

  readonly on = vi.fn((event: string, handler: Handler) => {
    if (event === "connection") this.connectionHandler = handler;
    return this;
  });

  connect(socket: FakeSocket): void {
    if (!this.connectionHandler) throw new Error("missing connection handler");
    this.connectionHandler(socket);
  }
}

class FakeSocket {
  readonly handlers = new Map<string, Handler>();
  readonly handshake = { auth: {}, headers: {} };
  readonly join = vi.fn();
  readonly leave = vi.fn();

  readonly on = vi.fn((event: string, handler: Handler) => {
    this.handlers.set(event, handler);
    return this;
  });

  emitRpc(request: unknown): Promise<RpcAck> {
    const handler = this.handlers.get("rpc");
    if (!handler) throw new Error("missing rpc handler");
    return new Promise((resolve) => {
      handler(request, resolve);
    });
  }
}

describe("socket.io rpc dispatch", () => {
  it("returns scenario templates without a CP", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const io = new FakeIo();
    const socket = new FakeSocket();

    registerSocketHandlers(io as never, { registry, bus, database: null });
    io.connect(socket);

    const ack = await socket.emitRpc({
      method: "scenario.templates",
      params: {},
    });

    expect(ack.ok).toBe(true);
    expect(registry.list()).toHaveLength(0);
    if (!ack.ok) return;
    expect(ack.result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "essential-cp-behavior" }),
      ]),
    );
  });
});
