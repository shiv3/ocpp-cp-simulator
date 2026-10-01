import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OCPPMessageHandler } from "../OCPPMessageHandler";
import { OCPPMessageType } from "../../../domain/types/OcppTypes";
import { OCPP_CALL_RESPONSE_TIMEOUT_MS } from "../../../domain/types/OcppCall";
import { Logger, LogLevel } from "../../../shared/Logger";
import type { ProtocolCodec } from "../profile/ProtocolProfile";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { GenerationToken, Settlement } from "../network-sim";

/**
 * #389: expert calls against the 1.6 serial queue, driven by fake timers —
 * what happens once the caller's 25 s wait is over.
 */
class FakeSocket {
  readonly written: Array<{ id: string; action: string }> = [];
  incoming: ((...args: unknown[]) => void) | null = null;
  private readonly gen: GenerationToken = { gen: 0, closeCause: null };

  setMessageHandler(handler: (...args: unknown[]) => void): void {
    this.incoming = handler;
  }
  currentGeneration(): GenerationToken {
    return this.gen;
  }
  isConnected(): boolean {
    return true;
  }
  sendAction(
    id: string,
    action: string,
    _payload: unknown,
    _gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): boolean {
    this.written.push({ id, action });
    onSettled?.({ outcome: "written" });
    return true;
  }
  answer(id: string, payload: unknown): void {
    this.incoming?.(OCPPMessageType.CALLRESULT, id, undefined, payload);
  }
}

function setup() {
  const socket = new FakeSocket();
  const chargePoint = {
    id: "CP",
    database: null,
    connectors: new Map(),
    configuration: { transactionMessageAttempts: () => 3 },
    notifyOutgoingCall: vi.fn(),
    onBootNotificationResult: vi.fn(),
  };
  const codec: ProtocolCodec = { outgoingWarning: () => null };
  const handler = new OCPPMessageHandler(
    chargePoint as unknown as ChargePoint,
    socket as unknown as OCPPWebSocket,
    new Logger(LogLevel.ERROR),
    codec,
  );
  handler.setBootStatus({ status: "Accepted" });
  return { socket, chargePoint, handler };
}

describe("1.6 expert calls after the caller's wait (#389)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("withdraws a call still queued when its wait expires, so it never goes out", async () => {
    const { socket, handler } = setup();
    // An unanswered Heartbeat holds the serial slot for 30 s.
    handler.sendHeartbeat();
    const queued = handler.sendOcppCall({ action: "Heartbeat", payload: {} });
    const outcome = queued.catch((err: unknown) => err);
    expect(socket.written).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(OCPP_CALL_RESPONSE_TIMEOUT_MS);
    expect(await outcome).toMatchObject({ reason: "timeout" });

    // The slot frees at 30 s; the withdrawn call must not follow.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.written).toHaveLength(1);
  });

  it("keeps a late answer away from the station unless applyResponse was set", async () => {
    const { socket, chargePoint, handler } = setup();
    const payload = { chargePointVendor: "V", chargePointModel: "M" };
    const accepted = {
      status: "Accepted",
      currentTime: "2026-09-30T00:00:00.000Z",
      interval: 300,
    };

    const late = handler
      .sendOcppCall({ action: "BootNotification", payload })
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(OCPP_CALL_RESPONSE_TIMEOUT_MS);
    expect(await late).toMatchObject({ reason: "timeout" });
    socket.answer(socket.written[0].id, accepted);
    expect(chargePoint.onBootNotificationResult).not.toHaveBeenCalled();

    const applied = handler
      .sendOcppCall({
        action: "BootNotification",
        payload,
        applyResponse: true,
      })
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(OCPP_CALL_RESPONSE_TIMEOUT_MS);
    expect(await applied).toMatchObject({ reason: "timeout" });
    socket.answer(socket.written[1].id, accepted);
    expect(chargePoint.onBootNotificationResult).toHaveBeenCalledTimes(1);
    expect(chargePoint.onBootNotificationResult).toHaveBeenCalledWith(accepted);
  });
});
