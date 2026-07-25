import { describe, expect, it } from "bun:test";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import {
  resolveNetworkSimConfig,
  type NetworkSimLayerConfig,
} from "../network-sim";
import { startMockCsms, type MockCsms } from "./mockCsms";

function canBindBunServe(): boolean {
  try {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("ok");
      },
    });
    void server.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function replyStatusNotificationV16(
  csms: MockCsms,
  connectorId: number,
): Promise<void> {
  const frame = await csms.waitForFrame(
    (candidate) =>
      candidate[0] === 2 &&
      candidate[2] === "StatusNotification" &&
      (candidate[3] as { connectorId?: number; status?: string })
        .connectorId === connectorId &&
      (candidate[3] as { connectorId?: number; status?: string }).status ===
        "Available",
    10000,
  );
  csms.replyCallResult(frame[1] as string, {});
}

async function acceptBootAndDrainV16(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-24T00:00:00.000Z",
    interval: 300,
  });

  // Wait for and reply to StatusNotifications from both connector 0 and 1
  await replyStatusNotificationV16(csms, 0);
  await replyStatusNotificationV16(csms, 1);
}

async function replyStatusNotificationV201(
  csms: MockCsms,
  evseId: number,
  connectorId: number,
): Promise<void> {
  const frame = await csms.waitForFrame(
    (candidate) =>
      candidate[0] === 2 &&
      candidate[2] === "StatusNotification" &&
      (candidate[3] as { evseId?: number; connectorId?: number }).evseId ===
        evseId &&
      (candidate[3] as { evseId?: number; connectorId?: number })
        .connectorId === connectorId &&
      (candidate[3] as { connectorStatus?: string }).connectorStatus ===
        "Available",
    10000,
  );
  csms.replyCallResult(frame[1] as string, {});
}

async function acceptBootAndDrainV201(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-24T00:00:00.000Z",
    interval: 300,
  });

  // Wait for and reply to StatusNotifications (evseId=0, connectorId=0 and evseId=1, connectorId=1)
  await replyStatusNotificationV201(csms, 0, 0);
  await replyStatusNotificationV201(csms, 1, 1);
}

describe.skipIf(!canBindBunServe())(
  "Network Simulator integration (wire suite)",
  () => {
    it("upstream latency enforces lower bound on frame delivery", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP-UPSTREAM-LATENCY",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
        {},
      );
      cp.events.on("error", () => undefined);
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");

      try {
        cp.connect();
        await acceptBootAndDrainV16(csms);

        // Apply latency AFTER boot handshake completes
        const upstreamLatencyConfig: NetworkSimLayerConfig = {
          enabled: true,
          seed: 1,
          rules: {
            upstreamLatency: {
              type: "latency",
              direction: "upstream",
              delayMs: 750,
            },
          },
        };
        const resolved = resolveNetworkSimConfig(
          upstreamLatencyConfig,
          null,
          "CP-UPSTREAM-LATENCY",
        );
        cp.setNetworkSimConfig(resolved);

        // Record time just before sending
        const t0 = Date.now();
        cp.sendHeartbeat();

        // Wait for Heartbeat.req to arrive at mock with 10s timeout
        const heartbeatFrame = await csms.waitForFrame(
          (f) => f[0] === 2 && f[2] === "Heartbeat",
          10000,
        );
        expect(heartbeatFrame).toBeDefined();

        // Find the frame in connections to get receivedAt
        const connections = csms.connections();
        const lastConnection = connections[connections.length - 1];
        const heartbeatReceived = lastConnection.frames
          .reverse()
          .find(
            (f) =>
              JSON.parse(f.raw)[0] === 2 &&
              JSON.parse(f.raw)[2] === "Heartbeat",
          );

        expect(heartbeatReceived).toBeDefined();
        // Assert lower bound: receivedAt >= t0 + 600 (0.8 × 750)
        // Never assert upper bound
        expect(heartbeatReceived!.receivedAt).toBeGreaterThanOrEqual(t0 + 600);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("latency does not break normal payload delivery", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP-LATENCY-INTEGRITY",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
        {},
      );
      cp.events.on("error", () => undefined);
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");

      try {
        cp.connect();
        await acceptBootAndDrainV16(csms);

        // Apply latency
        const latencyConfig: NetworkSimLayerConfig = {
          enabled: true,
          seed: 1,
          rules: {
            latency: {
              type: "latency",
              direction: "upstream",
              delayMs: 750,
            },
          },
        };
        const resolved = resolveNetworkSimConfig(
          latencyConfig,
          null,
          "CP-LATENCY-INTEGRITY",
        );
        cp.setNetworkSimConfig(resolved);

        // Send heartbeat
        cp.sendHeartbeat();

        // Wait for frame with 10s timeout
        const heartbeatFrame = await csms.waitForFrame(
          (f) => f[0] === 2 && f[2] === "Heartbeat",
          10000,
        );
        expect(heartbeatFrame).toBeDefined();
        // Payload should be intact (Heartbeat has minimal payload)
        expect(heartbeatFrame[0]).toBe(2); // CALL type
        expect(heartbeatFrame[2]).toBe("Heartbeat"); // Action
        expect(typeof heartbeatFrame[1]).toBe("string"); // messageId
        expect(typeof heartbeatFrame[3]).toBe("object"); // payload
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("forced disconnect + delayed reconnect enforces lower bound on reconnection delay", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP-FORCED-DISCONNECT",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
        {},
      );
      cp.events.on("error", () => undefined);
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");

      try {
        cp.connect();
        await acceptBootAndDrainV16(csms);

        // Apply manual-disconnect rule
        const disconnectConfig: NetworkSimLayerConfig = {
          enabled: true,
          seed: 1,
          rules: {
            manualDisconnect: {
              type: "manual-disconnect",
              reconnectDelayMs: 1500,
            },
          },
        };
        const resolved = resolveNetworkSimConfig(
          disconnectConfig,
          null,
          "CP-FORCED-DISCONNECT",
        );
        cp.setNetworkSimConfig(resolved);

        const closeCountBefore = csms.closeCount();
        const connectionsBefore = csms.connections();
        const closingConnection =
          connectionsBefore[connectionsBefore.length - 1];

        // Trigger the disconnect via manual rule
        cp.triggerNetworkSimDisconnect("manualDisconnect");

        // Wait for connection to close (eventual)
        const startWait = Date.now();
        while (
          csms.closeCount() === closeCountBefore &&
          Date.now() - startWait < 5000
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        expect(csms.closeCount()).toBeGreaterThan(closeCountBefore);

        // Now wait for reconnection
        const openCountBefore = csms.openCount();
        const startReconnectWait = Date.now();
        while (
          csms.openCount() <= openCountBefore &&
          Date.now() - startReconnectWait < 10000
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const connectionsAfter = csms.connections();
        const newConnection = connectionsAfter[connectionsAfter.length - 1];

        // Get the closedAt from the connection that was closed
        const closedAt = closingConnection.closedAt;
        expect(closedAt).not.toBeNull();

        // Assert lower bound: openedAt >= closedAt + 1200 (0.8 × 1500)
        expect(newConnection.openedAt).toBeGreaterThanOrEqual(closedAt! + 1200);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("transaction messages salvage across forced disconnect and reconnect", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP-TX-SALVAGE",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
        {},
      );
      cp.events.on("error", () => undefined);
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");

      try {
        cp.connect();
        await acceptBootAndDrainV16(csms);

        // Apply manual-disconnect rule
        const disconnectConfig: NetworkSimLayerConfig = {
          enabled: true,
          seed: 1,
          rules: {
            manualDisconnect: {
              type: "manual-disconnect",
              reconnectDelayMs: 1500,
            },
          },
        };
        const resolved = resolveNetworkSimConfig(
          disconnectConfig,
          null,
          "CP-TX-SALVAGE",
        );
        cp.setNetworkSimConfig(resolved);

        // Start a transaction
        cp.startTransaction("TAG-SALVAGE", 1);

        // CP first sends Preparing status before StartTransaction
        const preparingFrame = await csms.waitForFrame(
          (f) =>
            f[0] === 2 &&
            f[2] === "StatusNotification" &&
            (f[3] as { connectorId?: number; status?: string }).connectorId ===
              1 &&
            (f[3] as { connectorId?: number; status?: string }).status ===
              "Preparing",
          10000,
        );
        csms.replyCallResult(preparingFrame[1] as string, {});

        // Wait for StartTransaction to be sent
        const startTxFrame = await csms.waitForFrame(
          (f) => f[0] === 2 && f[2] === "StartTransaction",
          10000,
        );
        expect(startTxFrame).toBeDefined();
        csms.replyCallResult(startTxFrame[1] as string, {
          transactionId: 9001,
          idTagInfo: { status: "Accepted" },
        });

        // Force disconnect while transaction is active
        cp.triggerNetworkSimDisconnect("manualDisconnect");

        // Wait for new connection (with 10s timeout for disconnect delay + reconnect)
        await csms.waitForConnection(10000);

        // Accept new boot and drain startup
        const boot2 = await csms.waitForCall("BootNotification", 10000);
        csms.replyCallResult(boot2.messageId, {
          status: "Accepted",
          currentTime: "2026-06-24T00:05:00.000Z",
          interval: 300,
        });

        // Reply to StatusNotifications
        await replyStatusNotificationV16(csms, 0);
        await replyStatusNotificationV16(csms, 1);

        // The pending StartTransaction from before disconnect should be re-sent
        const reSentStartTx = await csms.waitForFrame(
          (f) => f[0] === 2 && f[2] === "StartTransaction",
          10000,
        );
        expect(reSentStartTx).toBeDefined();
        expect(reSentStartTx[0]).toBe(2);
        expect(reSentStartTx[2]).toBe("StartTransaction");
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("delayed downstream frame not dispatched after reconnect", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP-DOWNSTREAM-DELAY",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
        {},
      );
      cp.events.on("error", () => undefined);
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");

      try {
        cp.connect();
        await acceptBootAndDrainV16(csms);

        // Apply downstream latency + manual disconnect rule
        const downstreamConfig: NetworkSimLayerConfig = {
          enabled: true,
          seed: 1,
          rules: {
            downstreamLatency: {
              type: "latency",
              direction: "downstream",
              delayMs: 750,
            },
            manualDisconnect: {
              type: "manual-disconnect",
              reconnectDelayMs: 1500,
            },
          },
        };
        const resolved = resolveNetworkSimConfig(
          downstreamConfig,
          null,
          "CP-DOWNSTREAM-DELAY",
        );
        cp.setNetworkSimConfig(resolved);

        // Mock sends a TriggerMessage CALL
        const triggerId = "trigger-123";
        csms.send([
          2,
          triggerId,
          "TriggerMessage",
          { requestedMessage: "Heartbeat" },
        ]);

        // Force disconnect before the downstream frame is dispatched
        // (it's delayed in the pipeline)
        cp.triggerNetworkSimDisconnect("manualDisconnect");

        // Wait for reconnect
        const openCountBefore = csms.openCount();
        const startReconnectWait = Date.now();
        while (
          csms.openCount() <= openCountBefore &&
          Date.now() - startReconnectWait < 10000
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        // Accept new boot and drain startup
        const boot2 = await csms.waitForCall("BootNotification", 10000);
        csms.replyCallResult(boot2.messageId, {
          status: "Accepted",
          currentTime: "2026-06-24T00:05:00.000Z",
          interval: 300,
        });

        // Reply to StatusNotifications
        await replyStatusNotificationV16(csms, 0);
        await replyStatusNotificationV16(csms, 1);

        // Assert that CP did NOT respond to the stale TriggerMessage
        // Check that there's no CallResult for the trigger ID
        let foundTriggerResponse = false;
        for (const frame of csms.received) {
          if (frame[0] === 3 && frame[1] === triggerId) {
            foundTriggerResponse = true;
            break;
          }
        }
        // We expect no response to arrive (assertion: absence over window)
        // Give a short window to confirm absence
        await new Promise((resolve) => setTimeout(resolve, 500));
        for (const frame of csms.received) {
          if (frame[0] === 3 && frame[1] === triggerId) {
            foundTriggerResponse = true;
            break;
          }
        }
        expect(foundTriggerResponse).toBe(false);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("periodic disconnect may fire around boot without crashing", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP-PERIODIC-BOOT",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
        {},
      );
      let errorFired = false;
      cp.events.on("error", () => {
        errorFired = true;
      });
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");

      try {
        // Apply periodic-disconnect BEFORE connecting (so it fires around boot)
        const periodicConfig: NetworkSimLayerConfig = {
          enabled: true,
          seed: 1,
          rules: {
            periodicDisconnect: {
              type: "periodic-disconnect",
              intervalMs: 100,
              reconnectDelayMs: 200,
            },
          },
        };
        const resolved = resolveNetworkSimConfig(
          periodicConfig,
          null,
          "CP-PERIODIC-BOOT",
        );
        cp.setNetworkSimConfig(resolved);

        cp.connect();

        // Wait for boot acceptance (CP should reconnect and boot despite periodic disconnects)
        const boot = await csms.waitForCall("BootNotification", 10000);
        csms.replyCallResult(boot.messageId, {
          status: "Accepted",
          currentTime: "2026-06-24T00:00:00.000Z",
          interval: 300,
        });

        await acceptBootAndDrainV16(csms);

        // Assert no unhandled error was fired
        expect(errorFired).toBe(false);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("upstream latency lower bound on OCPP 2.0.1 charge point", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP-201-UPSTREAM-LATENCY",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-2.0.1",
        {},
      );
      cp.events.on("error", () => undefined);
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");

      try {
        cp.connect();
        await acceptBootAndDrainV201(csms);

        // Apply upstream latency
        const latencyConfig: NetworkSimLayerConfig = {
          enabled: true,
          seed: 42,
          rules: {
            upstreamLatency: {
              type: "latency",
              direction: "upstream",
              delayMs: 750,
            },
          },
        };
        const resolved = resolveNetworkSimConfig(
          latencyConfig,
          null,
          "CP-201-UPSTREAM-LATENCY",
        );
        cp.setNetworkSimConfig(resolved);

        // Record time before sending
        const t0 = Date.now();
        cp.sendHeartbeat();

        // Wait for Heartbeat.req with 10s timeout
        const heartbeatFrame = await csms.waitForFrame(
          (f) => f[0] === 2 && f[2] === "Heartbeat",
          10000,
        );
        expect(heartbeatFrame).toBeDefined();

        // Find receivedAt from connections
        const connections = csms.connections();
        const lastConnection = connections[connections.length - 1];
        const heartbeatReceived = lastConnection.frames
          .reverse()
          .find(
            (f) =>
              JSON.parse(f.raw)[0] === 2 &&
              JSON.parse(f.raw)[2] === "Heartbeat",
          );

        expect(heartbeatReceived).toBeDefined();
        // Assert lower bound: receivedAt >= t0 + 600 (0.8 × 750)
        expect(heartbeatReceived!.receivedAt).toBeGreaterThanOrEqual(t0 + 600);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("OCPP 2.1 smoke test: latency + forced disconnect", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP-21-SMOKE",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-2.1",
        {},
      );
      cp.events.on("error", () => undefined);
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");

      try {
        cp.connect();
        await acceptBootAndDrainV201(csms);

        // Apply latency + manual disconnect
        const smokeConfig: NetworkSimLayerConfig = {
          enabled: true,
          seed: 99,
          rules: {
            latency: {
              type: "latency",
              direction: "upstream",
              delayMs: 750,
            },
            disconnect: {
              type: "manual-disconnect",
              reconnectDelayMs: 1500,
            },
          },
        };
        const resolved = resolveNetworkSimConfig(
          smokeConfig,
          null,
          "CP-21-SMOKE",
        );
        cp.setNetworkSimConfig(resolved);

        // Test latency
        const t0 = Date.now();
        cp.sendHeartbeat();
        const heartbeatFrame = await csms.waitForFrame(
          (f) => f[0] === 2 && f[2] === "Heartbeat",
          10000,
        );
        expect(heartbeatFrame).toBeDefined();

        // Get receivedAt
        const connections = csms.connections();
        const lastConnection = connections[connections.length - 1];
        const heartbeatReceived = lastConnection.frames
          .reverse()
          .find(
            (f) =>
              JSON.parse(f.raw)[0] === 2 &&
              JSON.parse(f.raw)[2] === "Heartbeat",
          );

        // Assert lower bound
        expect(heartbeatReceived).toBeDefined();
        expect(heartbeatReceived!.receivedAt).toBeGreaterThanOrEqual(t0 + 600);

        // Test forced disconnect
        const closeCountBefore = csms.closeCount();
        const connectionsBefore = csms.connections();
        const closingConnection =
          connectionsBefore[connectionsBefore.length - 1];

        cp.triggerNetworkSimDisconnect("disconnect");

        // Wait for close
        const startWait = Date.now();
        while (
          csms.closeCount() === closeCountBefore &&
          Date.now() - startWait < 5000
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        expect(csms.closeCount()).toBeGreaterThan(closeCountBefore);

        // Wait for reconnect and verify timing
        const openCountBefore = csms.openCount();
        const startReconnectWait = Date.now();
        while (
          csms.openCount() <= openCountBefore &&
          Date.now() - startReconnectWait < 10000
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const connectionsAfter = csms.connections();
        const newConnection = connectionsAfter[connectionsAfter.length - 1];
        const closedAt = closingConnection.closedAt;

        expect(closedAt).not.toBeNull();
        // Assert lower bound: openedAt >= closedAt + 1200 (0.8 × 1500)
        expect(newConnection.openedAt).toBeGreaterThanOrEqual(closedAt! + 1200);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });
  },
);
