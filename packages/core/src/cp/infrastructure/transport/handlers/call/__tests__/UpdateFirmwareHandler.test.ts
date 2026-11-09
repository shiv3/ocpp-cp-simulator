import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateFirmwareHandler } from "../UpdateFirmwareHandler";
import { createChargePoint } from "../../../../charge-point/createChargePoint";
import { DefaultBootNotification } from "../../../../../domain/types/OcppTypes";
import { Logger } from "../../../../../shared/Logger";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import { isHandlerOutcome } from "../../../network-sim/ResponseEffectQueue";

/**
 * The handler only translates; the status train belongs to the charger
 * engine's `default.firmware` behavior. These tests drive it through the
 * handler on a real (unconnected) ChargePoint with the leaf send intercepted,
 * so the schedule under test is the one that ships.
 */
function buildContext() {
  const chargePoint = createChargePoint(
    "test-cp-update-firmware",
    DefaultBootNotification,
    1,
    "ws://localhost:8080",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
  const sent: string[] = [];
  vi.spyOn(chargePoint, "sendFirmwareStatusNotification").mockImplementation(
    (status) => {
      sent.push(status);
    },
  );
  const ctx: HandlerContext = { chargePoint, logger: new Logger() };
  return { ctx, sent };
}

describe("UpdateFirmwareHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty response immediately (§6.19)", () => {
    const { ctx } = buildContext();
    const res = new UpdateFirmwareHandler().handle(
      {
        location: "http://example.invalid/firmware.bin",
        retrieveDate: new Date(Date.now() + 1000).toISOString(),
      },
      ctx,
    );
    expect(isHandlerOutcome(res)).toBe(true);
    if (isHandlerOutcome(res)) {
      expect(res.payload).toEqual({});
    }
  });

  it("sends nothing before the response settled", async () => {
    const { ctx, sent } = buildContext();
    const res = new UpdateFirmwareHandler().handle(
      {
        location: "http://example.invalid/firmware.bin",
        retrieveDate: new Date(Date.now() - 1000).toISOString(),
      },
      ctx,
    );
    expect(isHandlerOutcome(res)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual([]);
  });

  it("walks the train from the settlement when retrieveDate is in the future", async () => {
    const { ctx, sent } = buildContext();
    const res = new UpdateFirmwareHandler().handle(
      {
        location: "http://example.invalid/firmware.bin",
        retrieveDate: new Date(Date.now() + 1000).toISOString(),
      },
      ctx,
    );
    if (!isHandlerOutcome(res)) throw new Error("expected an outcome");
    res.afterResponseSettled();
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["Downloading"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual(["Downloading", "Downloaded"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual(["Downloading", "Downloaded", "Installing"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
  });

  it("starts immediately when retrieveDate is invalid", async () => {
    const { ctx, sent } = buildContext();
    const res = new UpdateFirmwareHandler().handle(
      { location: "http://x", retrieveDate: "not-a-date" },
      ctx,
    );
    if (!isHandlerOutcome(res)) throw new Error("expected an outcome");
    res.afterResponseSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0]).toBe("Downloading");
  });

  it("ignores a second request while a train is running", async () => {
    const { ctx, sent } = buildContext();
    const handler = new UpdateFirmwareHandler();
    const request = {
      location: "http://x",
      retrieveDate: new Date(Date.now() - 1000).toISOString(),
    };
    for (let i = 0; i < 2; i++) {
      const res = handler.handle(request, ctx);
      if (!isHandlerOutcome(res)) throw new Error("expected an outcome");
      res.afterResponseSettled();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(sent).toEqual(["Downloading"]);
  });

  it("a disconnect stops the train", async () => {
    const { ctx, sent } = buildContext();
    const res = new UpdateFirmwareHandler().handle(
      {
        location: "http://x",
        retrieveDate: new Date(Date.now() - 1000).toISOString(),
      },
      ctx,
    );
    if (!isHandlerOutcome(res)) throw new Error("expected an outcome");
    res.afterResponseSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["Downloading"]);
    ctx.chargePoint.disconnect();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toEqual(["Downloading"]);
  });
});
