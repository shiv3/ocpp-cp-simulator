import { afterEach, describe, expect, it, vi } from "vitest";
import { ChargePoint, PowerStateError } from "../ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";
import { OCPPStatus } from "../../types/OcppTypes";

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

/** The CSMS-less rig leaves the connector in Preparing; make it Charging. */
async function chargingStatus(cp: ChargePoint): Promise<void> {
  await charging(cp);
  cp.updateConnectorStatus(1, OCPPStatus.Charging);
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

  it("refuses a power loss on an OCPP-S (SOAP) charge point", () => {
    const cp = build("OCPP-1.6S");
    expect(() => cp.powerLoss()).toThrow(PowerStateError);
    try {
      cp.powerLoss();
    } catch (error) {
      expect((error as PowerStateError).code).toBe("unsupported_transport");
    }
    expect(cp.poweredOff).toBe(false);
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

  it("refuses to stop, start, boot or reset while off; the recovery then ends it once with PowerLoss (#798)", async () => {
    const cp = build("OCPP-1.6J");
    await charging(cp);
    cp.powerLoss();
    const code = (fn: () => unknown): string | undefined => {
      try {
        fn();
      } catch (error) {
        return (error as PowerStateError).code;
      }
      return undefined;
    };
    expect(code(() => cp.stopTransaction(1))).toBe("powered_off");
    expect(code(() => cp.startTransaction("TAG-2", 1))).toBe("powered_off");
    expect(code(() => cp.boot())).toBe("powered_off");
    expect(code(() => cp.applyRemoteReset("Hard"))).toBe("powered_off");
    // Nothing ended: the connector keeps its transaction and its status.
    expect(cp.getConnector(1)?.hasRunningTransaction).toBe(true);

    cp.restorePower({ transactions: "end" });
    const stop = vi.spyOn(cp, "stopTransaction");
    accepted(cp);
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(
      expect.anything(),
      "PowerLoss",
      expect.anything(),
    );
    expect(cp.getConnector(1)?.hasRunningTransaction).toBe(false);
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

  it("an ending recovery does not report the pre-loss Charging after the reboot (#811 review)", async () => {
    const cp = build("OCPP-1.6J");
    await chargingStatus(cp);
    cp.powerLoss();
    cp.restorePower({ transactions: "end" });
    const reported: Array<[number, string]> = [];
    const update = cp.updateConnectorStatus.bind(cp);
    vi.spyOn(cp, "updateConnectorStatus").mockImplementation((id, status) => {
      reported.push([id, status]);
      update(id, status);
    });
    accepted(cp);
    await tick();
    expect(reported.filter(([id]) => id === 1).map(([, s]) => s)).not.toContain(
      "Charging",
    );
    expect(cp.getConnector(1)?.hasRunningTransaction).toBe(false);
  });

  it("keeps resumed transactions reported as before (#811 review)", async () => {
    const cp = build("OCPP-1.6J");
    await chargingStatus(cp);
    cp.powerLoss();
    cp.restorePower();
    const reported: string[] = [];
    const update = cp.updateConnectorStatus.bind(cp);
    vi.spyOn(cp, "updateConnectorStatus").mockImplementation((id, status) => {
      if (id === 1) reported.push(status);
      update(id, status);
    });
    accepted(cp);
    await tick();
    expect(reported).toContain("Charging");
  });

  it("the register stands still while off and never goes backwards after a resume (#798)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    const cp = build("OCPP-1.6J");
    await chargingStatus(cp);
    cp.setMeterValue(1, 5000);
    cp.powerLoss();
    const connector = cp.getConnector(1)!;
    const before = connector.meterValue;
    vi.setSystemTime(new Date("2026-01-01T11:00:00Z"));
    expect(connector.meterValue).toBe(before);
    cp.restorePower();
    accepted(cp);
    await tick();
    vi.setSystemTime(new Date("2026-01-01T11:05:00Z"));
    expect(connector.meterValue).toBeGreaterThanOrEqual(before);
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
