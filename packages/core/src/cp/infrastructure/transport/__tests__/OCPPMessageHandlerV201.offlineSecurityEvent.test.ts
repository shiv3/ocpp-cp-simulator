import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_QUEUED_SECURITY_EVENTS,
  OCPPMessageHandlerV201,
} from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { Logger } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Transaction } from "../../../domain/connector/Transaction";
import { OcppCallNoAnswerError } from "../../../domain/errors/OcppCallErrors";
import {
  CRITICAL_SECURITY_EVENT_TYPES,
  isCriticalSecurityEvent,
} from "../../../domain/security/securityEvents";
import { strictValidationErrors } from "@ocpp-cp-sim/ocpp/validate";
import { v201Schemas } from "@ocpp-cp-sim/ocpp/v201/schemas";
import { v21Schemas } from "@ocpp-cp-sim/ocpp/v21/schemas";

/**
 * #552, OCPP 2.0.1 / 2.1 A04.FR.02 on the E11 queue (#528): a critical
 * SecurityEventNotification produced while offline is queued and replayed
 * after Boot Accepted, as built (the time of the event), in the order it
 * was produced among the queued TransactionEvents.
 */

type Settle = (s: { outcome: string }) => void;

class FakeSocket {
  calls: Array<{ action: string; payload: unknown }> = [];
  connected = true;
  /** The next CALL of this action `sendAction` refuses, once. */
  refuseAction: string | null = null;
  /** When set, `sendAction` settles the CALL with this outcome, once, sending nothing. */
  settleOnce: string | null = null;
  setMessageHandler(): void {}
  onCloseTransaction(): void {}
  isConnected(): boolean {
    return this.connected;
  }
  currentGeneration(): { gen: number; closeCause: string | null } {
    return { gen: 1, closeCause: null };
  }
  sendAction(
    _messageId: string,
    action: string,
    payload: unknown,
    _gen: unknown,
    onSettled?: Settle,
  ): boolean {
    if (this.refuseAction === action) {
      this.refuseAction = null;
      return false;
    }
    if (this.settleOnce !== null) {
      const outcome = this.settleOnce;
      this.settleOnce = null;
      onSettled?.({ outcome });
      return true;
    }
    this.calls.push({ action, payload });
    onSettled?.({ outcome: "written" });
    return true;
  }
  actions(): string[] {
    return this.calls.map((c) => c.action);
  }
  securityEvents(): Record<string, unknown>[] {
    return this.calls
      .filter((c) => c.action === "SecurityEventNotification")
      .map((c) => c.payload as Record<string, unknown>);
  }
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const SCHEMAS: Record<string, object> = {
  "OCPP-2.0.1": v201Schemas.securityEventNotificationRequestV201,
  "OCPP-2.1": v21Schemas.securityEventNotificationRequestV21,
};

const T0 = new Date("2026-11-08T10:00:00.000Z");

function setup(ocppVersion: string) {
  const socket = new FakeSocket();
  const tx = {
    cpTransactionId: "tx-552",
    cpNextSeqNo: 0,
    tagId: "TAG-552",
    startTime: new Date("2026-11-08T09:00:00.000Z"),
    stopTime: null,
    meterStart: 0,
    meterStop: null,
  } as unknown as Transaction;
  const connector = { id: 1, transaction: tx, markTransactionChanged() {} };
  const cp = {
    id: `CP-552-${ocppVersion}`,
    database: null,
    ocppVersion,
    connectors: new Map([[1, connector]]),
    getConnector: () => connector,
    notifyOutgoingCall: vi.fn(),
    signedMeterFor: () => null,
    configuration: {
      transactionMessageAttempts: () => 3,
      transactionMessageRetryInterval: () => 60,
      messageTimeout: () => 30,
      meterValuesSampledData: () => [],
      offlineQueuingSeverity: () => 5,
    },
  };
  const handler = new OCPPMessageHandlerV201(
    cp as unknown as ChargePoint,
    socket as unknown as OCPPWebSocket,
    logger,
  );
  const close = () => {
    socket.connected = false;
    handler.onWebSocketClosed();
  };
  const reconnect = () => {
    socket.connected = true;
    handler.flushPendingQueue();
  };
  const start = () =>
    handler.sendTransactionEvent({
      phase: "started",
      transaction: tx,
      connectorId: 1,
    });
  return { socket, handler, close, reconnect, start };
}

describe("critical security events (Appendix 1)", () => {
  it("lists the 16 the Part 2 Appendices flag critical", () => {
    expect([...CRITICAL_SECURITY_EVENT_TYPES].sort()).toEqual([
      "DiscardedRenewedClientCertificate",
      "FirmwareUpdated",
      "InvalidChargingStationCertificate",
      "InvalidCsmsCertificate",
      "InvalidFirmwareSignature",
      "InvalidFirmwareSigningCertificate",
      "InvalidTLSCipherSuite",
      "InvalidTLSVersion",
      "MaintenanceLoginAccepted",
      "MaintenanceLoginFailed",
      "MemoryExhaustion",
      "ResetOrReboot",
      "SecurityLogWasCleared",
      "SettingSystemTime",
      "StartupOfTheDevice",
      "TamperDetectionActivated",
    ]);
    // Critical: No in the same table.
    for (const t of [
      "FailedToAuthenticateAtCsms",
      "CsmsFailedToAuthenticate",
      "ReconfigurationOfSecurityParameters",
      "AttemptedReplayAttacks",
    ])
      expect(isCriticalSecurityEvent(t)).toBe(false);
    expect(isCriticalSecurityEvent("InvalidMessages")).toBe(false);
    expect(isCriticalSecurityEvent("VendorSpecificEvent")).toBe(false);
  });
});

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s offline SecurityEventNotification queue (#552, A04.FR.02)",
  (version) => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      vi.mocked(logger.warn).mockClear();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("queues a critical event while offline and replays it, with the time it happened, after reconnect", async () => {
      const { socket, handler, close, reconnect } = setup(version);
      close();

      await handler.sendSecurityEventNotification(
        "TamperDetectionActivated",
        "cover opened",
      );
      expect(socket.calls).toEqual([]);

      vi.setSystemTime(new Date(T0.getTime() + 600_000));
      reconnect();

      const sent = socket.securityEvents();
      expect(sent).toEqual([
        {
          type: "TamperDetectionActivated",
          timestamp: "2026-11-08T10:00:00.000Z",
          techInfo: "cover opened",
        },
      ]);
      expect(strictValidationErrors(SCHEMAS[version], sent[0])).toEqual([]);
    });

    it("sends nothing queued twice", async () => {
      const { socket, handler, close, reconnect } = setup(version);
      close();
      await handler.sendSecurityEventNotification("ResetOrReboot");
      reconnect();
      reconnect();
      expect(socket.securityEvents()).toHaveLength(1);
    });

    it("drops a non-critical event while offline, rejecting as before", async () => {
      const { socket, handler, close, reconnect } = setup(version);
      close();

      await expect(
        handler.sendSecurityEventNotification("InvalidMessages"),
      ).rejects.toBeInstanceOf(OcppCallNoAnswerError);
      reconnect();

      expect(socket.calls).toEqual([]);
    });

    it.each(["socket_closed", "write_failed"])(
      "queues a critical event the pipeline drops with %s although the socket was up",
      async (outcome) => {
        const { socket, handler, reconnect } = setup(version);
        socket.settleOnce = outcome;

        await handler.sendSecurityEventNotification("InvalidCsmsCertificate");
        expect(socket.calls).toEqual([]);

        reconnect();
        expect(socket.securityEvents().map((e) => e.type)).toEqual([
          "InvalidCsmsCertificate",
        ]);
      },
    );

    it.each(["queue_overflow", "disposed"])(
      "does not queue a critical event the pipeline drops with %s",
      async (outcome) => {
        const { socket, handler, reconnect } = setup(version);
        socket.settleOnce = outcome;

        await expect(
          handler.sendSecurityEventNotification("InvalidCsmsCertificate"),
        ).rejects.toBeInstanceOf(OcppCallNoAnswerError);
        reconnect();
        expect(socket.calls).toEqual([]);
      },
    );

    it("sends a critical event at once while online", async () => {
      const { socket, handler } = setup(version);
      await handler.sendSecurityEventNotification("FirmwareUpdated");
      expect(socket.actions()).toEqual(["SecurityEventNotification"]);
    });

    it("replays among the queued TransactionEvents in the order produced", async () => {
      const { socket, handler, close, reconnect, start } = setup(version);
      close();
      start();
      await handler.sendSecurityEventNotification("SettingSystemTime");
      handler.sendTransactionUpdate(1, {
        triggerReason: "MeterValuePeriodic",
      });

      reconnect();

      expect(socket.actions()).toEqual([
        "TransactionEvent",
        "SecurityEventNotification",
        "TransactionEvent",
      ]);
    });

    it("keeps an event the socket refuses at the head and sends it after the next boot", async () => {
      const { socket, handler, close, reconnect } = setup(version);
      close();
      await handler.sendSecurityEventNotification("StartupOfTheDevice");
      await handler.sendSecurityEventNotification("MemoryExhaustion");
      socket.refuseAction = "SecurityEventNotification";

      reconnect();
      expect(socket.securityEvents()).toEqual([]);

      reconnect();
      expect(socket.securityEvents().map((e) => e.type)).toEqual([
        "StartupOfTheDevice",
        "MemoryExhaustion",
      ]);
    });

    it("keeps at most MAX_QUEUED_SECURITY_EVENTS, dropping the oldest", async () => {
      const { socket, handler, close, reconnect } = setup(version);
      close();
      for (let index = 0; index < MAX_QUEUED_SECURITY_EVENTS + 2; index += 1) {
        await handler.sendSecurityEventNotification(
          "SecurityLogWasCleared",
          `n${index}`,
        );
      }
      expect(logger.warn).toHaveBeenCalledTimes(1);

      reconnect();

      const sent = socket.securityEvents();
      expect(sent).toHaveLength(MAX_QUEUED_SECURITY_EVENTS);
      expect(sent[0].techInfo).toBe("n2");
      expect(sent.at(-1)?.techInfo).toBe(`n${MAX_QUEUED_SECURITY_EVENTS + 1}`);
    });
  },
);
