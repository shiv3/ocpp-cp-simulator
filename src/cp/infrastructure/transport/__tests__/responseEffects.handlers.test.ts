import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ResetHandler } from "../handlers/call/ResetHandler";
import { TriggerMessageHandler } from "../handlers/call/OtherCallHandlers";
import { ExtendedTriggerMessageHandler } from "../handlers/call/ExtendedTriggerMessageHandler";
import { GetDiagnosticsHandler } from "../handlers/call/GetDiagnosticsHandler";
import { GetLogHandler } from "../handlers/call/GetLogHandler";
import { UpdateFirmwareHandler } from "../handlers/call/UpdateFirmwareHandler";
import { SignedUpdateFirmwareHandler } from "../handlers/call/SignedUpdateFirmwareHandler";
import { Logger } from "../../../shared/Logger";
import type { HandlerContext } from "../handlers/MessageHandlerRegistry";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { isHandlerOutcome } from "../network-sim/ResponseEffectQueue";

function buildContext() {
  const chargePointCalls: Record<string, unknown[][]> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      (chargePointCalls[name] ??= []).push(args);
    };

  const chargePoint = {
    id: "test-cp",
    applyRemoteReset: record("applyRemoteReset"),
    sendCurrentStatusNotification: record("sendCurrentStatusNotification"),
    sendHeartbeat: record("sendHeartbeat"),
    sendMeterValue: record("sendMeterValue"),
    boot: record("boot"),
    sendDiagnosticsStatusNotification: record(
      "sendDiagnosticsStatusNotification",
    ),
    sendFirmwareStatusNotification: record("sendFirmwareStatusNotification"),
    sendSignCertificate: vi.fn(() => Promise.resolve()),
    sendLogStatusNotification: record("sendLogStatusNotification"),
    sendSignedFirmwareStatusNotification: record(
      "sendSignedFirmwareStatusNotification",
    ),
    simulateFirmwareUpdate: record("simulateFirmwareUpdate"),
    simulateSignedFirmwareUpdate: record("simulateSignedFirmwareUpdate"),
    connectors: new Map([
      [1, { id: 1 }],
      [2, { id: 2 }],
    ]),
  };

  const logger = new Logger();

  const ctx: HandlerContext = {
    chargePoint: chargePoint as unknown as ChargePoint,
    logger,
  };

  return { ctx, chargePointCalls, chargePoint };
}

describe("responseEffects.handlers", () => {
  let fetchSpy: any = null;

  beforeEach(() => {
    // Polyfill Blob/File/FormData for GetDiagnosticsHandler
    if (typeof globalThis.Blob === "undefined") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Blob = class Blob {
        constructor(
          public parts: unknown[],
          public opts?: unknown,
        ) {}
      };
    }
    if (typeof globalThis.File === "undefined") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).File = class File extends (globalThis as any).Blob {
        constructor(
          parts: unknown[],
          public name: string,
        ) {
          super(parts);
        }
      };
    }
    if (typeof globalThis.FormData === "undefined") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).FormData = class FormData {
        append(): void {}
      };
    }
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  describe("ResetHandler", () => {
    it("returns HandlerOutcome with Accepted status", () => {
      const { ctx } = buildContext();
      const handler = new ResetHandler();
      const result = handler.handle({ type: "Soft" }, ctx);

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        expect(result.payload).toEqual({ status: "Accepted" });
      }
    });

    it("effect calls applyRemoteReset with the payload type", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new ResetHandler();
      const result = handler.handle({ type: "Hard" }, ctx);

      // Before effect runs, should not be called
      expect(chargePointCalls.applyRemoteReset).toBeUndefined();

      // Run the effect
      if (isHandlerOutcome(result)) {
        result.afterResponseSettled();
        expect(chargePointCalls.applyRemoteReset).toEqual([["Hard"]]);
      }
    });
  });

  describe("TriggerMessageHandler", () => {
    it("returns NotImplemented for unsupported requestedMessage", () => {
      const { ctx } = buildContext();
      const handler = new TriggerMessageHandler();
      const result = handler.handle(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { requestedMessage: "Unsupported" as any },
        ctx,
      );
      // This branch returns bare response (not an outcome)
      expect(result).toEqual({ status: "NotImplemented" });
      expect(isHandlerOutcome(result)).toBe(false);
    });

    it("StatusNotification returns HandlerOutcome and calls sendCurrentStatusNotification", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new TriggerMessageHandler();
      const result = handler.handle(
        { requestedMessage: "StatusNotification", connectorId: 1 },
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        expect(result.payload).toEqual({ status: "Accepted" });
        expect(chargePointCalls.sendCurrentStatusNotification).toBeUndefined();

        result.afterResponseSettled();
        expect(chargePointCalls.sendCurrentStatusNotification).toEqual([[1]]);
      }
    });

    it("Heartbeat returns HandlerOutcome and calls sendHeartbeat", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new TriggerMessageHandler();
      const result = handler.handle({ requestedMessage: "Heartbeat" }, ctx);

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        expect(result.payload).toEqual({ status: "Accepted" });
        result.afterResponseSettled();
        expect(chargePointCalls.sendHeartbeat).toHaveLength(1);
      }
    });

    it("MeterValues with no connectorId calls sendMeterValue for all connectors", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new TriggerMessageHandler();
      const result = handler.handle({ requestedMessage: "MeterValues" }, ctx);

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        expect(result.payload).toEqual({ status: "Accepted" });
        result.afterResponseSettled();
        expect(chargePointCalls.sendMeterValue).toEqual([[1], [2]]);
      }
    });

    it("MeterValues with specific connectorId calls sendMeterValue once", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new TriggerMessageHandler();
      const result = handler.handle(
        { requestedMessage: "MeterValues", connectorId: 2 },
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        result.afterResponseSettled();
        expect(chargePointCalls.sendMeterValue).toEqual([[2]]);
      }
    });

    it("BootNotification returns HandlerOutcome and calls boot", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new TriggerMessageHandler();
      const result = handler.handle(
        { requestedMessage: "BootNotification" },
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        result.afterResponseSettled();
        expect(chargePointCalls.boot).toHaveLength(1);
      }
    });

    it("DiagnosticsStatusNotification returns HandlerOutcome and calls sendDiagnosticsStatusNotification", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new TriggerMessageHandler();
      const result = handler.handle(
        { requestedMessage: "DiagnosticsStatusNotification" },
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        result.afterResponseSettled();
        expect(chargePointCalls.sendDiagnosticsStatusNotification).toEqual([
          ["Idle"],
        ]);
      }
    });

    it("FirmwareStatusNotification returns HandlerOutcome and calls sendFirmwareStatusNotification", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new TriggerMessageHandler();
      const result = handler.handle(
        { requestedMessage: "FirmwareStatusNotification" },
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        result.afterResponseSettled();
        expect(chargePointCalls.sendFirmwareStatusNotification).toEqual([
          ["Idle"],
        ]);
      }
    });
  });

  describe("ExtendedTriggerMessageHandler", () => {
    it("returns NotImplemented for unsupported requestedMessage", () => {
      const { ctx } = buildContext();
      const handler = new ExtendedTriggerMessageHandler();
      const result = handler.handle(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { requestedMessage: "Unsupported" as any },
        ctx,
      );
      expect(result).toEqual({ status: "NotImplemented" });
      expect(isHandlerOutcome(result)).toBe(false);
    });

    it("StatusNotification returns HandlerOutcome and calls sendCurrentStatusNotification", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new ExtendedTriggerMessageHandler();
      const result = handler.handle(
        { requestedMessage: "StatusNotification", connectorId: 1 },
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        expect(result.payload).toEqual({ status: "Accepted" });
        result.afterResponseSettled();
        expect(chargePointCalls.sendCurrentStatusNotification).toEqual([[1]]);
      }
    });

    it("Heartbeat returns HandlerOutcome and calls sendHeartbeat", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new ExtendedTriggerMessageHandler();
      const result = handler.handle({ requestedMessage: "Heartbeat" }, ctx);

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        result.afterResponseSettled();
        expect(chargePointCalls.sendHeartbeat).toHaveLength(1);
      }
    });

    it("MeterValues returns HandlerOutcome and calls sendMeterValue", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new ExtendedTriggerMessageHandler();
      const result = handler.handle({ requestedMessage: "MeterValues" }, ctx);

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        result.afterResponseSettled();
        expect(chargePointCalls.sendMeterValue).toEqual([[1], [2]]);
      }
    });

    it("BootNotification returns HandlerOutcome and calls boot", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new ExtendedTriggerMessageHandler();
      const result = handler.handle(
        { requestedMessage: "BootNotification" },
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        result.afterResponseSettled();
        expect(chargePointCalls.boot).toHaveLength(1);
      }
    });

    it("SignChargePointCertificate returns HandlerOutcome and calls sendSignCertificate", async () => {
      const { ctx, chargePoint } = buildContext();
      const handler = new ExtendedTriggerMessageHandler();
      const result = handler.handle(
        { requestedMessage: "SignChargePointCertificate" },
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        result.afterResponseSettled();
        await Promise.resolve(); // drain microtask queue
        expect(chargePoint.sendSignCertificate).toHaveBeenCalledTimes(1);
      }
    });

    it("LogStatusNotification returns HandlerOutcome and calls sendLogStatusNotification", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new ExtendedTriggerMessageHandler();
      const result = handler.handle(
        { requestedMessage: "LogStatusNotification" },
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        result.afterResponseSettled();
        expect(chargePointCalls.sendLogStatusNotification).toEqual([["Idle"]]);
      }
    });

    it("FirmwareStatusNotification returns HandlerOutcome and calls sendSignedFirmwareStatusNotification", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new ExtendedTriggerMessageHandler();
      const result = handler.handle(
        { requestedMessage: "FirmwareStatusNotification" },
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        result.afterResponseSettled();
        expect(chargePointCalls.sendSignedFirmwareStatusNotification).toEqual([
          ["Idle"],
        ]);
      }
    });
  });

  describe("GetDiagnosticsHandler", () => {
    it("returns HandlerOutcome with fileName", () => {
      fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("", { status: 200 }));
      const { ctx } = buildContext();
      const handler = new GetDiagnosticsHandler();
      const result = handler.handle({ location: "http://example/upload" }, ctx);

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        expect(result.payload).toEqual({ fileName: "diagnostics.txt" });
      }
    });

    it("effect sends Uploading status on settlement", () => {
      fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("", { status: 200 }));
      const { ctx, chargePointCalls } = buildContext();
      const handler = new GetDiagnosticsHandler();
      const result = handler.handle({ location: "http://example/upload" }, ctx);

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        expect(
          chargePointCalls.sendDiagnosticsStatusNotification,
        ).toBeUndefined();
        result.afterResponseSettled();
        // First call should be Uploading
        expect(chargePointCalls.sendDiagnosticsStatusNotification?.[0]).toEqual(
          ["Uploading"],
        );
      }
    });
  });

  describe("GetLogHandler", () => {
    it("returns HandlerOutcome with Accepted and filename", () => {
      const { ctx } = buildContext();
      const handler = new GetLogHandler();
      const result = handler.handle(
        {
          logType: "SecurityLog",
          requestId: 123,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          log: { remoteLocation: "http://example.invalid/upload" } as any,
        },
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        expect(result.payload).toEqual({
          status: "Accepted",
          filename: "test-cp-SecurityLog-123.log",
        });
      }
    });

    it("effect sends Uploading status and schedules Uploaded", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new GetLogHandler();
      const result = handler.handle(
        {
          logType: "SecurityLog",
          requestId: 123,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          log: { remoteLocation: "http://example.invalid/upload" } as any,
        },
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        expect(chargePointCalls.sendLogStatusNotification).toBeUndefined();
        result.afterResponseSettled();
        // First call should be Uploading
        expect(chargePointCalls.sendLogStatusNotification?.[0]).toEqual([
          "Uploading",
          123,
        ]);
        // The Uploaded call is scheduled via setTimeout, so we don't verify it here
      }
    });
  });

  describe("UpdateFirmwareHandler", () => {
    it("returns HandlerOutcome with empty status", () => {
      const { ctx } = buildContext();
      const handler = new UpdateFirmwareHandler();
      const result = handler.handle(
        {
          location: "http://example/firmware",
          retrieveDate: new Date().toISOString(),
        },
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        expect(result.payload).toEqual({});
      }
    });

    it("effect calls simulateFirmwareUpdate on settlement", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new UpdateFirmwareHandler();
      const now = new Date();
      const result = handler.handle(
        {
          location: "http://example/firmware",
          retrieveDate: now.toISOString(),
        },
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        expect(chargePointCalls.simulateFirmwareUpdate).toBeUndefined();
        result.afterResponseSettled();
        expect(chargePointCalls.simulateFirmwareUpdate).toHaveLength(1);
      }
    });
  });

  describe("SignedUpdateFirmwareHandler", () => {
    it("returns HandlerOutcome with Accepted status", () => {
      const { ctx } = buildContext();
      const handler = new SignedUpdateFirmwareHandler();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = handler.handle(
        {
          requestId: 456,
          firmware: {
            location: "http://example/signed-firmware",
            retrieveDateTime: new Date().toISOString(),
            signingCertificate: "cert",
            signature: "sig",
          },
        } as any,
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        expect(result.payload).toEqual({ status: "Accepted" });
      }
    });

    it("effect calls simulateSignedFirmwareUpdate with requestId on settlement", () => {
      const { ctx, chargePointCalls } = buildContext();
      const handler = new SignedUpdateFirmwareHandler();
      const now = new Date();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = handler.handle(
        {
          requestId: 789,
          firmware: {
            location: "http://example/signed-firmware",
            retrieveDateTime: now.toISOString(),
            signingCertificate: "cert",
            signature: "sig",
          },
        } as any,
        ctx,
      );

      expect(isHandlerOutcome(result)).toBe(true);
      if (isHandlerOutcome(result)) {
        expect(chargePointCalls.simulateSignedFirmwareUpdate).toBeUndefined();
        result.afterResponseSettled();
        const calls = chargePointCalls.simulateSignedFirmwareUpdate;
        expect(calls).toHaveLength(1);
        // Verify that requestId (789) is passed as the second argument
        expect(calls?.[0][1]).toBe(789);
      }
    });
  });
});
