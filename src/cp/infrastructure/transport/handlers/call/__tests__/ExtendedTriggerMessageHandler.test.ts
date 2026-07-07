import { describe, it, expect, vi } from "vitest";
import { ExtendedTriggerMessageHandler } from "../ExtendedTriggerMessageHandler";
import { Logger } from "../../../../../shared/Logger";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import type { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";

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
    expect(res).toEqual({ status: "Accepted" });
    expect(calls.sendCurrentStatusNotification).toBeUndefined();
    await Promise.resolve();
    expect(calls.sendCurrentStatusNotification).toEqual([[1]]);
  });

  it("Accepted + fires Heartbeat", async () => {
    const { ctx, calls } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle({ requestedMessage: "Heartbeat" }, ctx);
    expect(res).toEqual({ status: "Accepted" });
    await Promise.resolve();
    expect(calls.sendHeartbeat).toHaveLength(1);
  });

  it("Accepted + fans out MeterValues to every connector when connectorId is omitted", async () => {
    const { ctx, calls } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle({ requestedMessage: "MeterValues" }, ctx);
    expect(res).toEqual({ status: "Accepted" });
    await Promise.resolve();
    expect(calls.sendMeterValue).toEqual([[1], [2]]);
  });

  it("Accepted + sends MeterValues for a single connectorId", async () => {
    const { ctx, calls } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    handler.handle({ requestedMessage: "MeterValues", connectorId: 2 }, ctx);
    await Promise.resolve();
    expect(calls.sendMeterValue).toEqual([[2]]);
  });

  it("Accepted + re-sends BootNotification", async () => {
    const { ctx, calls } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle({ requestedMessage: "BootNotification" }, ctx);
    expect(res).toEqual({ status: "Accepted" });
    await Promise.resolve();
    expect(calls.boot).toHaveLength(1);
  });

  it("Accepted + triggers SignChargePointCertificate via sendSignCertificate", async () => {
    const { ctx, chargePoint } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle(
      { requestedMessage: "SignChargePointCertificate" },
      ctx,
    );
    expect(res).toEqual({ status: "Accepted" });
    await Promise.resolve();
    expect(chargePoint.sendSignCertificate).toHaveBeenCalledTimes(1);
  });

  it("Accepted + sends LogStatusNotification Idle", async () => {
    const { ctx, calls } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle(
      { requestedMessage: "LogStatusNotification" },
      ctx,
    );
    expect(res).toEqual({ status: "Accepted" });
    await Promise.resolve();
    expect(calls.sendLogStatusNotification).toEqual([["Idle"]]);
  });

  it("Accepted + sends SignedFirmwareStatusNotification Idle", async () => {
    const { ctx, calls } = buildContext();
    const handler = new ExtendedTriggerMessageHandler();
    const res = handler.handle(
      { requestedMessage: "FirmwareStatusNotification" },
      ctx,
    );
    expect(res).toEqual({ status: "Accepted" });
    await Promise.resolve();
    expect(calls.sendSignedFirmwareStatusNotification).toEqual([["Idle"]]);
  });
});
