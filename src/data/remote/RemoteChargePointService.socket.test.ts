/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChargePointEvent } from "../interfaces/ChargePointService";
import {
  RpcFailure,
  type CpListItem,
  type EventEnvelope,
  type StatusWire,
  type SubscribeResult,
} from "../../protocol";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";

type Handler = (...args: any[]) => void;

interface PendingAck {
  event: string;
  request: any;
  timeoutMs: number | null;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

const socketMockState = vi.hoisted(() => {
  class MockSocket {
    connected = false;
    readonly handlers = new Map<string, Set<Handler>>();
    readonly managerHandlers = new Map<string, Set<Handler>>();
    readonly acks: PendingAck[] = [];
    private timeoutMs: number | null = null;

    readonly io = {
      on: vi.fn((event: string, handler: Handler) => {
        this.add(this.managerHandlers, event, handler);
        return this.io;
      }),
      off: vi.fn((event: string, handler: Handler) => {
        this.managerHandlers.get(event)?.delete(handler);
        return this.io;
      }),
    };

    readonly on = vi.fn((event: string, handler: Handler) => {
      this.add(this.handlers, event, handler);
      return this;
    });

    readonly off = vi.fn((event: string, handler: Handler) => {
      this.handlers.get(event)?.delete(handler);
      return this;
    });

    readonly timeout = vi.fn((timeoutMs: number) => {
      this.timeoutMs = timeoutMs;
      return this;
    });

    readonly emitWithAck = vi.fn((event: string, request: any) => {
      const timeoutMs = this.timeoutMs;
      this.timeoutMs = null;
      return new Promise((resolve, reject) => {
        this.acks.push({ event, request, timeoutMs, resolve, reject });
      });
    });

    readonly connect = vi.fn(() => {
      if (!this.connected) {
        this.connected = true;
        this.trigger("connect");
      }
      return this;
    });

    readonly disconnect = vi.fn(() => {
      if (this.connected) {
        this.connected = false;
        this.trigger("disconnect", "io client disconnect");
      }
      return this;
    });

    trigger(event: string, ...args: unknown[]): void {
      if (event === "connect") this.connected = true;
      if (event === "disconnect") this.connected = false;
      this.handlers.get(event)?.forEach((handler) => handler(...args));
    }

    triggerManager(event: string, ...args: unknown[]): void {
      this.managerHandlers.get(event)?.forEach((handler) => handler(...args));
    }

    serverEvent(envelope: EventEnvelope): void {
      this.trigger("event", envelope);
    }

    private add(
      map: Map<string, Set<Handler>>,
      event: string,
      handler: Handler,
    ): void {
      const handlers = map.get(event) ?? new Set<Handler>();
      handlers.add(handler);
      map.set(event, handlers);
    }
  }

  const sockets: MockSocket[] = [];
  const io = vi.fn(() => {
    const socket = new MockSocket();
    sockets.push(socket);
    return socket;
  });

  return { sockets, io };
});

vi.mock("socket.io-client", () => ({
  io: socketMockState.io,
}));

import { RemoteChargePointService } from "./RemoteChargePointService";

function latestSocket() {
  const socket = socketMockState.sockets[socketMockState.sockets.length - 1];
  if (!socket) throw new Error("socket was not created");
  return socket;
}

function nextAck(): PendingAck {
  const ack = latestSocket().acks.shift();
  if (!ack) throw new Error("missing pending ack");
  return ack;
}

function flush(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

function cpItem(cpId = "cp-1", status = "Available"): CpListItem {
  return {
    cpId,
    status,
    wsUrl: "ws://example.test/ocpp",
    connectors: 1,
    vendor: "Vendor",
    model: "Model",
    basicAuth: null,
    bootNotification: null,
  };
}

function statusWire(cpId = "cp-1", status = "Available"): StatusWire {
  return {
    id: cpId,
    status,
    error: "",
    connectors: [],
    config: {
      wsUrl: "ws://example.test/ocpp",
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
      bootNotification: null,
    },
  };
}

function subscribeResult(scope = "cp-1"): SubscribeResult {
  return {
    subscribed: [scope],
    snapshot: {
      cps: [cpItem("cp-1")],
      perCp: scope === "registry" ? {} : { "cp-1": statusWire("cp-1") },
    },
  };
}

beforeEach(() => {
  socketMockState.sockets.splice(0);
  socketMockState.io.mockClear();
});

describe("RemoteChargePointService socket.io rpc", () => {
  it("resolves rpc calls from an ok ack", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const promise = service.connect("cp-1");
    const ack = nextAck();

    expect(ack.event).toBe("rpc");
    expect(ack.request).toEqual({
      cpId: "cp-1",
      method: "connect",
      params: {},
    });

    ack.resolve({ ok: true, result: undefined });
    await expect(promise).resolves.toBeUndefined();
  });

  it("sends StatusNotification options on update_connector_status rpc", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const timestamp = new Date("2026-01-02T03:04:05.000Z");
    const promise = service.sendStatusNotification(
      "cp-1",
      1,
      OCPPStatus.Faulted,
      {
        errorCode: "EVCommunicationError",
        info: "pilot lost",
        vendorErrorCode: "E-42",
        vendorId: "Vendor",
        timestamp,
        suppressChargingStateTransactionEvent: true,
      },
    );
    const ack = nextAck();

    expect(ack.request).toEqual({
      cpId: "cp-1",
      method: "update_connector_status",
      params: {
        connector: 1,
        status: "Faulted",
        errorCode: "EVCommunicationError",
        info: "pilot lost",
        vendorErrorCode: "E-42",
        vendorId: "Vendor",
        timestamp: "2026-01-02T03:04:05.000Z",
        suppressChargingStateTransactionEvent: true,
      },
    });

    ack.resolve({ ok: true, result: undefined });
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects pending rpc calls on disconnect", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const promise = service.connect("cp-1");

    latestSocket().trigger("disconnect", "transport close");

    await expect(promise).rejects.toMatchObject({
      name: "RpcFailure",
      code: "disconnected",
    });
  });

  it("rejects pending rpc calls on timeout", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const promise = service.connect("cp-1");

    nextAck().reject(new Error("operation has timed out"));

    await expect(promise).rejects.toMatchObject({
      name: "RpcFailure",
      code: "timeout",
    });
  });

  it("applies a subscribe snapshot before queued cp events", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const events: ChargePointEvent[] = [];

    service.subscribe("cp-1", (event) => events.push(event));
    const ack = nextAck();
    expect(ack.request.method).toBe("events.subscribe");

    latestSocket().serverEvent({
      kind: "cp",
      cpId: "cp-1",
      evt: {
        event: "status_change",
        data: { status: "Charging" },
      },
    });
    expect(events).toEqual([]);

    ack.resolve({ ok: true, result: subscribeResult("cp-1") });
    await flush();

    expect(events.map((event) => event.type)).toEqual(["status", "status"]);
    expect(events[0]).toEqual({ type: "status", status: "Available" });
    expect(events[1]).toEqual({ type: "status", status: "Charging" });
  });

  it("reconnect resync re-subscribes without cp.list or status rpc calls", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");

    service.subscribe("cp-1", () => {});
    nextAck().resolve({ ok: true, result: subscribeResult("cp-1") });
    await flush();
    latestSocket().acks.splice(0);

    latestSocket().trigger("disconnect", "transport close");
    latestSocket().trigger("connect");
    await flush();

    const resubscribe = nextAck();
    expect(resubscribe.request.method).toBe("events.subscribe");
    resubscribe.resolve({ ok: true, result: subscribeResult("cp-1") });
    await flush();

    const methods = latestSocket().acks.map((ack) => ack.request.method);
    expect(["events.subscribe", ...methods]).not.toContain("cp.list");
    expect(["events.subscribe", ...methods]).not.toContain("status");
  });

  it("reset is composed from a disconnect rpc then a connect rpc", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");

    service.subscribe("cp-1", () => {});
    nextAck().resolve({ ok: true, result: subscribeResult("cp-1") });
    await flush();
    latestSocket().acks.splice(0);

    // Auto-resolve every rpc ack across all sockets until reset settles
    // (order-robust against any interleaved reconnect resync).
    let settled = false;
    const promise = service.reset("cp-1").then(() => {
      settled = true;
    });
    for (let i = 0; i < 100 && !settled; i++) {
      await flush();
      for (const sock of socketMockState.sockets) {
        let ack = sock.acks.shift();
        while (ack) {
          ack.resolve({
            ok: true,
            result:
              ack.request.method === "events.subscribe"
                ? subscribeResult("cp-1")
                : undefined,
          });
          ack = sock.acks.shift();
        }
      }
    }
    await promise;
    expect(settled).toBe(true);

    // reset = OCPP-level disconnect then connect (no separate cp.reset).
    const methods = socketMockState.sockets.flatMap((sock) =>
      sock.emitWithAck.mock.calls.map(
        (call) => (call[1] as { method: string }).method,
      ),
    );
    expect(methods).toContain("disconnect");
    expect(methods).toContain("connect");
    expect(methods.indexOf("disconnect")).toBeLessThan(
      methods.lastIndexOf("connect"),
    );
  });

  it("throws Error with server rpc failure message", async () => {
    const service = new RemoteChargePointService("http://127.0.0.1:9700");
    const promise = service.connect("cp-1");

    nextAck().resolve({
      ok: false,
      error: { code: "not_found", message: "missing cp" },
    });

    await expect(promise).rejects.toBeInstanceOf(RpcFailure);
    await expect(promise).rejects.toMatchObject({
      code: "not_found",
      message: "missing cp",
    });
  });
});
