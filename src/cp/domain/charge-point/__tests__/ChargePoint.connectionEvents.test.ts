import { afterEach, describe, expect, it, vi } from "vitest";
import { ChargePoint } from "../ChargePoint";
import type { BootNotification } from "../../types/OcppTypes";
import { DefaultBootNotification } from "../../types/OcppTypes";

/**
 * #448: the operational timeline needs domain signals for an injected
 * network fault, each scheduled reconnect, and why a transaction stopped.
 */

const bootNotification: BootNotification = DefaultBootNotification;

function buildChargePoint(): ChargePoint {
  return new ChargePoint(
    "test-cp-448",
    bootNotification,
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
}

describe("ChargePoint connection events (#448)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits networkFaultInjected when a manual-disconnect rule fires", () => {
    const cp = buildChargePoint();
    cp.setNetworkSimConfig({
      enabled: true,
      seed: 1,
      rules: { cut: { type: "manual-disconnect", reconnectDelayMs: 750 } },
    });
    const faults: unknown[] = [];
    cp.events.on("networkFaultInjected", (fault) => faults.push(fault));

    expect(cp.triggerNetworkSimDisconnect("cut")).toEqual({ ok: true });

    expect(faults).toEqual([
      { ruleId: "cut", ruleType: "manual-disconnect", reconnectDelayMs: 750 },
    ]);
  });

  it("re-emits the transport's reconnect notice as reconnecting", () => {
    const cp = buildChargePoint();
    const attempts: unknown[] = [];
    cp.events.on("reconnecting", (info) => attempts.push(info));

    cp["_webSocket"]!.observers.emit("reconnectScheduled", {
      attempt: 1,
      delayMs: 1000,
    });

    expect(attempts).toEqual([{ attempt: 1, delayMs: 1000 }]);
  });

  it("reports the stop reason on transactionStopped", async () => {
    const cp = buildChargePoint();
    await cp.startTransaction("TAG-1", 1, undefined, undefined, {
      triggerReason: "RemoteStart",
    });
    const stops: unknown[] = [];
    cp.events.on("transactionStopped", (stop) => stops.push(stop));

    cp.stopTransaction(1, "EVDisconnected");

    expect(stops).toEqual([
      { connectorId: 1, transactionId: 0, reason: "EVDisconnected" },
    ]);
  });
});
