import { afterEach, describe, expect, it, vi } from "vitest";
import { ChargePoint, PowerStateError } from "../ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";

/**
 * #455: a power loss is neither a network loss nor an OCPP Reset. The
 * transactions survive it; what the station sends after the reboot depends
 * on the version (1.6 §4.2 / §7.36 PowerLoss; 2.x B01.FR.03, E17).
 */

const built: ChargePoint[] = [];

function build(version: string): ChargePoint {
  const cp = new ChargePoint(
    "cp-455",
    DefaultBootNotification,
    1,
    "ws://127.0.0.1:9/",
    null,
    null,
    null,
    {},
    [],
    version,
    {},
  );
  cp.events.on("error", () => undefined);
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  built.push(cp);
  return cp;
}

async function charging(cp: ChargePoint): Promise<void> {
  await cp.startTransaction("TAG-1", 1);
}

function accepted(cp: ChargePoint): void {
  cp.onBootNotificationResult({
    status: "Accepted",
    interval: 60,
    currentTime: new Date().toISOString(),
  });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("ChargePoint power loss (#455)", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const cp of built.splice(0)) cp.dispose();
  });

  it("keeps the transaction and refuses a connect while off", async () => {
    const cp = build("OCPP-1.6J");
    await charging(cp);
    const lost: unknown[] = [];
    cp.events.on("powerLost", (e) => lost.push(e));

    const record = cp.powerLoss();

    expect(record.transactions).toHaveLength(1);
    expect(lost).toEqual([{ transactions: 1 }]);
    expect(cp.poweredOff).toBe(true);
    expect(cp.getConnector(1)?.hasRunningTransaction).toBe(true);
    const connect = vi.spyOn(cp["_webSocket"]!, "connect");
    cp.connect();
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a second loss and a restore without a loss", () => {
    const cp = build("OCPP-1.6J");
    expect(() => cp.restorePower()).toThrow(PowerStateError);
    cp.powerLoss();
    expect(() => cp.powerLoss()).toThrow(PowerStateError);
  });

  it("1.6 resumes by default: nothing is stopped", async () => {
    const cp = build("OCPP-1.6J");
    await charging(cp);
    cp.powerLoss();
    const stop = vi.spyOn(cp, "stopTransaction");
    const result = cp.restorePower();
    expect(result.recovery).toBe("resume");
    accepted(cp);
    await tick();
    expect(stop).not.toHaveBeenCalled();
    expect(cp.getConnector(1)?.hasRunningTransaction).toBe(true);
  });

  it("1.6 can end with reason PowerLoss, stamped with the loss", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    const cp = build("OCPP-1.6J");
    await charging(cp);
    cp.powerLoss();
    vi.setSystemTime(new Date("2026-01-01T10:05:00Z"));
    const result = cp.restorePower({ transactions: "end" });
    expect(result).toMatchObject({ recovery: "end", outageMs: 300_000 });
    const stop = vi.spyOn(cp, "stopTransaction");
    accepted(cp);
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledWith(expect.anything(), "PowerLoss", {
      triggerReason: "AbnormalCondition",
      stoppedReason: "PowerLoss",
      stoppedAt: new Date("2026-01-01T10:00:00Z"),
    });
  });

  it("2.0.1 ends by default (no TxResumed in that version)", async () => {
    const cp = build("OCPP-2.0.1");
    await charging(cp);
    cp.powerLoss();
    expect(cp.restorePower().recovery).toBe("end");
  });

  describe("2.1 (E17)", () => {
    it("ends without a TxResumptionTimeout (E17.FR.01, TC_E_114)", async () => {
      const cp = build("OCPP-2.1");
      await charging(cp);
      cp.powerLoss();
      expect(cp.restorePower().recovery).toBe("end");
    });

    it("ends when the outage outlasted the timeout (E17.FR.20)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
      const cp = build("OCPP-2.1");
      await charging(cp);
      cp.powerLoss();
      vi.setSystemTime(new Date("2026-01-01T10:00:30Z"));
      expect(cp.restorePower({ txResumptionTimeoutSeconds: 20 }).recovery).toBe(
        "end",
      );
    });

    it("resumes within the timeout and sends Updated + TxResumed (E17.FR.10/14)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
      const cp = build("OCPP-2.1");
      await charging(cp);
      cp.updateConnectorStatus(1, "Charging" as never);
      cp.powerLoss();
      vi.setSystemTime(new Date("2026-01-01T10:00:10Z"));
      const result = cp.restorePower({ txResumptionTimeoutSeconds: 10 });
      expect(result.recovery).toBe("resume");
      const update = vi.spyOn(cp["_outbox"], "sendTransactionUpdate");
      accepted(cp);
      await Promise.resolve();
      await Promise.resolve();
      expect(update).toHaveBeenCalledWith(1, {
        triggerReason: "TxResumed",
        chargingState: "Charging",
      });
    });
  });

  it("reports none when nothing was running", () => {
    const cp = build("OCPP-1.6J");
    cp.powerLoss();
    expect(cp.restorePower()).toMatchObject({
      recovery: "none",
      transactions: 0,
    });
  });
});
