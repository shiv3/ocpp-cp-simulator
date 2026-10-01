/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";
import { startMockCsms } from "../../../cp/infrastructure/transport/__tests__/mockCsms";

/**
 * #395: the daemon's Socket.IO control plane carries the same
 * `boot_notification` event as JSON Lines, in a `kind: "cp"` envelope, after
 * `connected` — so an external orchestrator can tell "socket open" from
 * "registered by the CSMS" without inferring it from `status_change`.
 */
const servers: TestServer[] = [];
const csmsList: ReturnType<typeof startMockCsms>[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (csmsList.length > 0) await csmsList.pop()?.stop();
});

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(5_000).emitWithAck("rpc", request);
}

describe("boot_notification over the daemon Socket.IO control plane (#395)", () => {
  it("pushes the CSMS's BootNotification answer after connected", async () => {
    const csms = startMockCsms();
    csmsList.push(csms);
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    const cpId = "CPBOOT395";

    try {
      server.registry.create(
        {
          cpId,
          wsUrl: csms.url,
          connectors: 1,
          vendor: "test",
          model: "test",
          basicAuth: null,
        },
        { seedDefault: false },
      );
      const cpEvents: any[] = [];
      let resolveBoot!: () => void;
      const booted = new Promise<void>((r) => (resolveBoot = r));
      socket.on("event", (envelope: any) => {
        if (envelope?.kind !== "cp" || envelope.cpId !== cpId) return;
        cpEvents.push(envelope.evt);
        if (envelope.evt.event === "boot_notification") resolveBoot();
      });
      expect(
        (
          await emitRpc(socket, {
            method: "events.subscribe",
            params: { scope: cpId },
          })
        ).ok,
      ).toBe(true);

      const connectAck = emitRpc(socket, {
        cpId,
        method: "connect",
        params: {},
      });
      const boot = await csms.waitForCall("BootNotification");
      csms.replyCallResult(boot.messageId, {
        currentTime: "2026-09-30T12:00:00.000Z",
        interval: 300,
        status: "Accepted",
      });
      await connectAck;

      await booted;

      const bootEvents = cpEvents.filter(
        (evt) => evt.event === "boot_notification",
      );
      expect(bootEvents).toHaveLength(1);
      expect(bootEvents[0].data).toEqual({
        status: "Accepted",
        interval: 300,
        currentTime: "2026-09-30T12:00:00.000Z",
      });
      const names = cpEvents.map((evt) => evt.event);
      expect(names.indexOf("connected")).toBeGreaterThanOrEqual(0);
      expect(names.indexOf("connected")).toBeLessThan(
        names.indexOf("boot_notification"),
      );
    } finally {
      socket.disconnect();
    }
  }, 30_000);
});
