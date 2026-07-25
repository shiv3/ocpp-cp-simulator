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
    sendCurrentStatusNotification: record("sendCurrentStatusNotification"),
    sendHeartbeat: record("sendHeartbeat"),
    sendMeterValue: record("sendMeterValue"),
    boot: record("boot"),
    sendSignCertificate: vi.fn(() => Promise.resolve()),
    sendLogStatusNotification: record("sendLogStatusNotification"),
    sendSignedFirmwareStatusNotification: record(
      "sendSignedFirmwareStatusNotification",
    ),
    connectors: new Map([
      [1, { id: 1 }],
      [2, { id: 2 }],
    ]),
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
      expect(calls.sendLogStatusNotification).toEqual([["Idle"]]);
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
      expect(calls.sendSignedFirmwareStatusNotification).toEqual([["Idle"]]);
    }
  });
});
