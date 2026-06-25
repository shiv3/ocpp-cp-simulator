/* eslint-disable @typescript-eslint/no-explicit-any -- test ack/event payloads */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import type { ChargePointInitOptions } from "../../types";
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

describe("socket.io registry event bridge", () => {
  it("emits a redacted registry added event to registry subscribers", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      await subscribe(socket, "registry");

      const nextEvent = waitForMatchingEvent(
        socket,
        (event) => event.kind === "registry" && event.change === "added",
      );
      server.registry.create(cpInit("cp-added"), { seedDefault: false });
      const event = await nextEvent;

      expect(event.cp.cpId).toBe("cp-added");
      expect(event.cp.basicAuth).toEqual({ username: "user" });
      expect(event.cp.wsUrl).toBe("ws://example.test/ocpp");
      expect(JSON.stringify(event)).not.toContain("secret");
      expect(JSON.stringify(event)).not.toContain("user:secret@");
    } finally {
      socket.disconnect();
    }
  });

  it("does not flood registry updated events when meter values leave the compact summary unchanged", async () => {
    const server = await serverWithCp("cp-alpha", 1);
    const socket = await connectTestClient(server);
    try {
      await subscribe(socket, "registry");
      const service = server.registry.get("cp-alpha");
      if (!service) throw new Error("missing test CP");

      const events = await collectEvents(socket, () => {
        for (let i = 0; i < 5; i++) {
          service.setMeterValue(1, 1000 + i);
        }
      });

      const updated = events.filter(
        (event) => event.kind === "registry" && event.change === "updated",
      );
      expect(updated.length).toBeLessThanOrEqual(1);
    } finally {
      socket.disconnect();
    }
  });

  it("emits registry updated when connector_removed changes the compact summary", async () => {
    const server = await serverWithCp("cp-alpha", 2);
    const socket = await connectTestClient(server);
    try {
      await subscribe(socket, "registry");
      const service = server.registry.get("cp-alpha");
      if (!service) throw new Error("missing test CP");

      const nextUpdated = waitForMatchingEvent(
        socket,
        (event) => event.kind === "registry" && event.change === "updated",
      );
      expect(service.removeConnector(2)).toBe(true);
      const event = await nextUpdated;

      expect(event.cp.cpId).toBe("cp-alpha");
      expect(event.cp.status).toBeString();
    } finally {
      socket.disconnect();
    }
  });

  it("fans one CP event to both star and cpId subscribers", async () => {
    const server = await serverWithCp("cp-alpha", 1);
    const star = await connectTestClient(server);
    const scoped = await connectTestClient(server);
    try {
      await subscribe(star, "*");
      await subscribe(scoped, "cp-alpha");

      const starEvents: any[] = [];
      const scopedEvents: any[] = [];
      star.on("event", (event) => starEvents.push(event));
      scoped.on("event", (event) => scopedEvents.push(event));

      server.bus.publish("cp-alpha", {
        event: "meter_value",
        data: { connectorId: 1, meterValue: 1234 },
      });
      await sleep(100);

      expect(cpEvents(starEvents)).toHaveLength(1);
      expect(cpEvents(scopedEvents)).toHaveLength(1);
      expect(cpEvents(starEvents)[0].cpId).toBe("cp-alpha");
      expect(cpEvents(scopedEvents)[0].cpId).toBe("cp-alpha");
    } finally {
      star.disconnect();
      scoped.disconnect();
    }
  });

  it("does not leak CP passwords or embedded URL credentials through registry or CP pushes", async () => {
    const server = await startAndTrack();
    const socket = await connectTestClient(server);
    try {
      await subscribe(socket, "*");

      const nextAdded = waitForMatchingEvent(
        socket,
        (event) => event.kind === "registry" && event.change === "added",
      );
      server.registry.create(cpInit("cp-redact"), { seedDefault: false });
      const added = await nextAdded;

      const nextCp = waitForMatchingEvent(
        socket,
        (event) => event.kind === "cp" && event.cpId === "cp-redact",
      );
      server.bus.publish("cp-redact", {
        event: "log",
        data: {
          level: 1,
          type: "test",
          message: "ws://user:secret@example.test/ocpp",
          password: "secret",
        },
      } as any);
      const cpEvent = await nextCp;

      expect(JSON.stringify(added)).not.toContain("secret");
      expect(JSON.stringify(added)).not.toContain("user:secret@");
      expect(JSON.stringify(cpEvent)).not.toContain("secret");
      expect(JSON.stringify(cpEvent)).not.toContain("user:secret@");
      expect(JSON.stringify(cpEvent)).not.toContain("password");
    } finally {
      socket.disconnect();
    }
  });
});

async function startAndTrack(): Promise<TestServer> {
  const server = await startTestServer();
  servers.push(server);
  return server;
}

async function serverWithCp(
  cpId: string,
  connectors: number,
): Promise<TestServer> {
  const server = await startAndTrack();
  server.registry.create(cpInit(cpId, connectors), { seedDefault: false });
  return server;
}

function cpInit(cpId: string, connectors = 1): ChargePointInitOptions {
  return {
    cpId,
    wsUrl: "ws://user:secret@example.test/ocpp",
    connectors,
    vendor: "TestVendor",
    model: "TestModel",
    basicAuth: { username: "user", password: "secret" },
    ocppVersion: "OCPP-1.6J",
  };
}

function subscribe(socket: Socket, scope: string): Promise<any> {
  return socket.timeout(2_000).emitWithAck("events.subscribe", { scope });
}

function waitForMatchingEvent(
  socket: Socket,
  predicate: (event: any) => boolean,
  timeoutMs = 2_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for socket event"));
    }, timeoutMs);
    const onEvent = (event: any) => {
      if (!predicate(event)) return;
      cleanup();
      resolve(event);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("event", onEvent);
    };
    socket.on("event", onEvent);
  });
}

async function collectEvents(
  socket: Socket,
  trigger: () => void,
): Promise<any[]> {
  const events: any[] = [];
  const onEvent = (event: any) => events.push(event);
  socket.on("event", onEvent);
  try {
    trigger();
    await sleep(100);
  } finally {
    socket.off("event", onEvent);
  }
  return events;
}

function cpEvents(events: any[]): any[] {
  return events.filter((event) => event.kind === "cp");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
