import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignedUpdateFirmwareHandler } from "../SignedUpdateFirmwareHandler";
import { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../../../domain/types/OcppTypes";
import { Logger } from "../../../../../shared/Logger";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import { isHandlerOutcome } from "../../../network-sim/ResponseEffectQueue";

/**
 * The handler only translates; the signed status train belongs to the
 * `default.signedFirmware` behavior of the charger engine. Driven here through
 * the handler on a real (unconnected) ChargePoint with the leaf send
 * intercepted.
 */
function buildContext() {
  const chargePoint = new ChargePoint(
    "test-cp-signed-firmware",
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
  const sent: Array<{ status: string; requestId?: number }> = [];
  vi.spyOn(
    chargePoint,
    "sendSignedFirmwareStatusNotification",
  ).mockImplementation((status, requestId) => {
    sent.push({ status, requestId });
  });
  const ctx: HandlerContext = { chargePoint, logger: new Logger() };
  return { ctx, sent };
}

function firmwarePayload(
  overrides: Partial<{ retrieveDateTime: string; requestId: number }> = {},
) {
  return {
    requestId: overrides.requestId ?? 5,
    firmware: {
      location: "http://example.invalid/firmware.bin",
      retrieveDateTime:
        overrides.retrieveDateTime ?? new Date(Date.now() + 1000).toISOString(),
      signingCertificate:
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      signature: "deadbeef",
    },
  };
}

describe("SignedUpdateFirmwareHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Accepted immediately", () => {
    const { ctx } = buildContext();
    const res = new SignedUpdateFirmwareHandler().handle(
      firmwarePayload(),
      ctx,
    );
    expect(isHandlerOutcome(res)).toBe(true);
    if (isHandlerOutcome(res)) {
      expect(res.payload).toEqual({ status: "Accepted" });
    }
  });

  it("sends nothing before the response settled", async () => {
    const { ctx, sent } = buildContext();
    new SignedUpdateFirmwareHandler().handle(
      firmwarePayload({
        retrieveDateTime: new Date(Date.now() - 1000).toISOString(),
      }),
      ctx,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual([]);
  });

  it("fires Downloading → Downloaded → SignatureVerified → Installing → Installed carrying requestId", async () => {
    const { ctx, sent } = buildContext();
    const res = new SignedUpdateFirmwareHandler().handle(
      firmwarePayload({ requestId: 9 }),
      ctx,
    );
    if (!isHandlerOutcome(res)) throw new Error("expected an outcome");
    res.afterResponseSettled();
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([{ status: "Downloading", requestId: 9 }]);
    await vi.advanceTimersByTimeAsync(8000);
    expect(sent).toEqual([
      { status: "Downloading", requestId: 9 },
      { status: "Downloaded", requestId: 9 },
      { status: "SignatureVerified", requestId: 9 },
      { status: "Installing", requestId: 9 },
      { status: "Installed", requestId: 9 },
    ]);
  });

  it("starts immediately when retrieveDateTime is invalid", async () => {
    const { ctx, sent } = buildContext();
    const res = new SignedUpdateFirmwareHandler().handle(
      firmwarePayload({ retrieveDateTime: "not-a-date", requestId: 1 }),
      ctx,
    );
    if (!isHandlerOutcome(res)) throw new Error("expected an outcome");
    res.afterResponseSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0]).toEqual({ status: "Downloading", requestId: 1 });
  });

  it("ignores a second request while a train is running and stops on disconnect", async () => {
    const { ctx, sent } = buildContext();
    const handler = new SignedUpdateFirmwareHandler();
    for (let i = 0; i < 2; i++) {
      const res = handler.handle(
        firmwarePayload({
          retrieveDateTime: new Date(Date.now() - 1000).toISOString(),
        }),
        ctx,
      );
      if (!isHandlerOutcome(res)) throw new Error("expected an outcome");
      res.afterResponseSettled();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(sent).toEqual([{ status: "Downloading", requestId: 5 }]);
    ctx.chargePoint.disconnect();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toHaveLength(1);
  });
});
