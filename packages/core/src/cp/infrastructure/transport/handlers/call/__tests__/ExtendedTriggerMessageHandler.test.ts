import { describe, it, expect, vi } from "vitest";
import { ExtendedTriggerMessageHandler } from "../ExtendedTriggerMessageHandler";
import { Logger } from "../../../../../shared/Logger";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import type { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";
import { isHandlerOutcome } from "../../../network-sim/ResponseEffectQueue";

function buildContext() {
  const calls: Record<string, unknown[][]> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
    };

  const chargePoint = {
    runTriggered: <T>(fn: () => T): T => fn(),
    sendCurrentStatusNotification: record("sendCurrentStatusNotification"),
    sendHeartbeat: record("sendHeartbeat"),
    sendMeterValue: record("sendMeterValue"),
    boot: record("boot"),
    sendSignCertificate: vi.fn(() => Promise.resolve()),
    sendLogStatusNotification: record("sendLogStatusNotification"),
    sendSignedFirmwareStatusNotification: record(
      "sendSignedFirmwareStatusNotification",
    ),
    engine: {
      state: {
        log: { status: "Idle", requestId: null },
        signedFirmware: { status: "Idle", requestId: null },
      } as Record<string, { status: string; requestId: number | null }>,
    },
    connectors: new Map([
      [1, { id: 1 }],
      [2, { id: 2 }],
    ]),
    getConnector: (id: number) => (id === 1 || id === 2 ? { id } : undefined),
  };

  const ctx: HandlerContext = {
    chargePoint: chargePoint as unknown as ChargePoint,
    logger: new Logger(),
  };
  return { ctx, calls, chargePoint };
}

describe("ExtendedTriggerMessageHandler", () => {
  it("returns NotImplemented for an unsupported requestedMessage", () => {
    const { ctx } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { requestedMessage: "Unsupported" as any },
      ctx,
    );
    expect(res).toEqual({ status: "NotImplemented" });
  });

  it("Accepted + fires StatusNotification after the microtask queue drains", async () => {
    const { ctx, calls } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle(
      { requestedMessage: "StatusNotification", connectorId: 1 },
      ctx,
    );
    expect(isHandlerOutcome(res)).toBe(true);
    if (isHandlerOutcome(res)) {
      expect(res.payload).toEqual({ status: "Accepted" });
      expect(calls.sendCurrentStatusNotification).toBeUndefined();
      // Effect runs after settlement (invoke it directly here)
      res.afterResponseSettled();
      expect(calls.sendCurrentStatusNotification).toEqual([[1]]);
    }
  });

  it("Accepted + fires Heartbeat", async () => {
    const { ctx, calls } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle({ requestedMessage: "Heartbeat" }, ctx);
    expect(isHandlerOutcome(res)).toBe(true);
    if (isHandlerOutcome(res)) {
      expect(res.payload).toEqual({ status: "Accepted" });
      res.afterResponseSettled();
      expect(calls.sendHeartbeat).toHaveLength(1);
    }
  });

  it("Accepted + fans out MeterValues to every connector when connectorId is omitted", async () => {
    const { ctx, calls } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle({ requestedMessage: "MeterValues" }, ctx);
    expect(isHandlerOutcome(res)).toBe(true);
    if (isHandlerOutcome(res)) {
      expect(res.payload).toEqual({ status: "Accepted" });
      res.afterResponseSettled();
      expect(calls.sendMeterValue).toEqual([[1], [2]]);
    }
  });

  it("Accepted + sends MeterValues for a single connectorId", async () => {
    const { ctx, calls } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle(
      { requestedMessage: "MeterValues", connectorId: 2 },
      ctx,
    );
    expect(isHandlerOutcome(res)).toBe(true);
    if (isHandlerOutcome(res)) {
      res.afterResponseSettled();
      expect(calls.sendMeterValue).toEqual([[2]]);
    }
  });

  it("Accepted + re-sends BootNotification", async () => {
    const { ctx, calls } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle({ requestedMessage: "BootNotification" }, ctx);
    expect(isHandlerOutcome(res)).toBe(true);
    if (isHandlerOutcome(res)) {
      expect(res.payload).toEqual({ status: "Accepted" });
      res.afterResponseSettled();
      expect(calls.boot).toHaveLength(1);
    }
  });

  it("Accepted + triggers SignChargePointCertificate via sendSignCertificate", async () => {
    const { ctx, chargePoint } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle(
      { requestedMessage: "SignChargePointCertificate" },
      ctx,
    );
    expect(isHandlerOutcome(res)).toBe(true);
    if (isHandlerOutcome(res)) {
      expect(res.payload).toEqual({ status: "Accepted" });
      res.afterResponseSettled();
      expect(chargePoint.sendSignCertificate).toHaveBeenCalledTimes(1);
    }
  });

  it("Accepted + sends LogStatusNotification Idle", async () => {
    const { ctx, calls } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle(
      { requestedMessage: "LogStatusNotification" },
      ctx,
    );
    expect(isHandlerOutcome(res)).toBe(true);
    if (isHandlerOutcome(res)) {
      expect(res.payload).toEqual({ status: "Accepted" });
      res.afterResponseSettled();
      expect(calls.sendLogStatusNotification).toEqual([["Idle", undefined]]);
    }
  });

  it("Accepted + sends SignedFirmwareStatusNotification Idle", async () => {
    const { ctx, calls } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle(
      { requestedMessage: "FirmwareStatusNotification" },
      ctx,
    );
    expect(isHandlerOutcome(res)).toBe(true);
    if (isHandlerOutcome(res)) {
      expect(res.payload).toEqual({ status: "Accepted" });
      res.afterResponseSettled();
      expect(calls.sendSignedFirmwareStatusNotification).toEqual([
        ["Idle", undefined],
      ]);
    }
  });

  it("rejects StatusNotification and MeterValues for a connector that does not exist (§5.17)", () => {
    const { ctx, calls } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    for (const requestedMessage of [
      "StatusNotification",
      "MeterValues",
    ] as const) {
      expect(
        handler.handle({ requestedMessage, connectorId: 99 }, ctx),
      ).toEqual({
        status: "Rejected",
      });
    }
    expect(calls).toEqual({});
  });

  it("still sends a Heartbeat for any connectorId", () => {
    const { ctx, calls } = buildContext();
    const res = new ExtendedTriggerMessageHandler().handle(
      { requestedMessage: "Heartbeat", connectorId: 99 },
      ctx,
    );
    if (!isHandlerOutcome(res)) throw new Error("expected an outcome");
    res.afterResponseSettled();
    expect(calls.sendHeartbeat).toEqual([[]]);
  });

  it("reports the upload in progress with its requestId (N01.FR.12)", () => {
    const { ctx, calls, chargePoint } = buildContext();
    chargePoint.engine.state.log = { status: "Uploading", requestId: 9 };
    const res = new ExtendedTriggerMessageHandler().handle(
      { requestedMessage: "LogStatusNotification" },
      ctx,
    );
    if (!isHandlerOutcome(res)) throw new Error("expected an outcome");
    res.afterResponseSettled();
    expect(calls.sendLogStatusNotification).toEqual([["Uploading", 9]]);
  });

  it("repeats a failed install, then Idle after Installed (L01.FR.28/29)", () => {
    const { ctx, calls, chargePoint } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    chargePoint.engine.state.signedFirmware = {
      status: "InstallationFailed",
      requestId: 5,
    };
    const failed = handler.handle(
      { requestedMessage: "FirmwareStatusNotification" },
      ctx,
    );
    if (!isHandlerOutcome(failed)) throw new Error("expected an outcome");
    failed.afterResponseSettled();
    chargePoint.engine.state.signedFirmware = {
      status: "Installed",
      requestId: 5,
    };
    const installed = handler.handle(
      { requestedMessage: "FirmwareStatusNotification" },
      ctx,
    );
    if (!isHandlerOutcome(installed)) throw new Error("expected an outcome");
    installed.afterResponseSettled();
    expect(calls.sendSignedFirmwareStatusNotification).toEqual([
      ["InstallationFailed", 5],
      ["Idle", undefined],
    ]);
  });
});
