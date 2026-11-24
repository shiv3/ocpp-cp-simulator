import { describe, expect, it } from "bun:test";
import type { TransactionEventRequestV201 } from "@ocpp-cp-simulator/ocpp/index";
import {
  answerTo,
  startMockCsms,
  type MockCsms,
  type OcppFrame,
} from "./mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
  callOf,
  callsOf,
} from "./stationHarness";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { OCPPStatus } from "../../../domain/types/OcppTypes";

/**
 * #835 / #608 on a real station. The vehicle's behavior drives the existing
 * readiness operation (#453), so the wire effect is the one `evSetReady`
 * already has: StatusNotification `SuspendedEV` on OCPP 1.6 (§4.9 C4 / D3) and
 * TransactionEvent Updated with chargingState `SuspendedEV` on 2.0.1 (E-section
 * ChargingStateEnumType). The power request itself never reaches the wire as a
 * message; it is a term of the operating point.
 */

const statusOf = (status: string) => (frame: OcppFrame) =>
  frame[2] === "StatusNotification" &&
  frame[0] === 2 &&
  ((frame[3] as { status?: string }).status === status ||
    (frame[3] as { connectorStatus?: string }).connectorStatus === status);

async function v16(csms: MockCsms, id: string, connectors = 1) {
  const cp = await bootedChargePoint(csms, id, "OCPP-1.6J", { connectors });
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  const stop = answerEverythingElse(csms, ["StartTransaction"]);
  return { cp, stop };
}

async function startV16(
  cp: ChargePoint,
  csms: MockCsms,
  connectorId: number,
  txId: number,
) {
  const before = csms.received.length;
  cp.startTransaction(`TAG-${txId}`, connectorId);
  const start = await csms.waitForFrame(
    (f) => callOf("StartTransaction")(f) && csms.received.indexOf(f) >= before,
  );
  csms.replyCallResult(start[1] as string, {
    transactionId: txId,
    idTagInfo: { status: "Accepted" },
  });
}

describe("vehicle behavior on OCPP 1.6 (#835)", () => {
  it("a delayed vehicle connects, waits as SuspendedEV, then charges", async () => {
    const csms = startMockCsms();
    const { cp, stop } = await v16(csms, "CP16-VB-DELAY");
    try {
      const connector = cp.getConnector(1)!;
      connector.applyEvSettingsOverride({
        vehicleBehavior: { policy: { type: "delayed", delayMs: 1500 } },
      });
      cp.evPlugIn(1);
      await startV16(cp, csms, 1, 8350);
      await csms.waitForFrame(statusOf("SuspendedEV"));
      expect(connector.operatingPoint().acceptedW).toBe(0);
      expect(connector.hasRunningTransaction).toBe(true);
      // The delay passes: the vehicle asks for energy, the same operation
      // resumes the charge (D3).
      await csms.waitForFrame(
        (f) =>
          statusOf("Charging")(f) &&
          csms.received.indexOf(f) >
            csms.received.findIndex(statusOf("SuspendedEV")),
        6000,
      );
      expect(connector.status).toBe(OCPPStatus.Charging);
    } finally {
      stop();
      cp.dispose();
      csms.stop();
    }
  }, 15000);

  it("a reached target stops the demand without ending the transaction", async () => {
    const csms = startMockCsms();
    const { cp, stop } = await v16(csms, "CP16-VB-TARGET");
    try {
      const connector = cp.getConnector(1)!;
      connector.applyEvSettingsOverride({
        vehicleBehavior: { preset: "target-soc", intent: { targetSoc: 60 } },
      });
      cp.evPlugIn(1);
      await startV16(cp, csms, 1, 8351);
      await csms.waitForFrame(statusOf("Charging"));
      connector.soc = 61;
      await csms.waitForFrame(statusOf("SuspendedEV"), 6000);
      expect(connector.hasRunningTransaction).toBe(true);
      expect(callsOf(csms, "StopTransaction")).toHaveLength(0);
      expect(connector.vehicleSnapshot()?.phase).toBe("complete");
    } finally {
      stop();
      cp.dispose();
      csms.stop();
    }
  }, 15000);

  it("stopWhenDone ends the transaction when the target is reached", async () => {
    const csms = startMockCsms();
    const { cp, stop } = await v16(csms, "CP16-VB-STOP");
    try {
      const connector = cp.getConnector(1)!;
      connector.applyEvSettingsOverride({
        vehicleBehavior: {
          preset: "target-soc",
          intent: { targetSoc: 60 },
          stopWhenDone: true,
        },
      });
      cp.evPlugIn(1);
      await startV16(cp, csms, 1, 8352);
      await csms.waitForFrame(statusOf("Charging"));
      connector.soc = 70;
      await csms.waitForCall("StopTransaction", 6000);
    } finally {
      stop();
      cp.dispose();
      csms.stop();
    }
  }, 15000);

  it("without a behavior nothing changes", async () => {
    const csms = startMockCsms();
    const { cp, stop } = await v16(csms, "CP16-VB-NONE");
    try {
      const connector = cp.getConnector(1)!;
      cp.evPlugIn(1);
      await startV16(cp, csms, 1, 8353);
      await csms.waitForFrame(statusOf("Charging"));
      expect(connector.vehicleSnapshot()).toBeNull();
      expect(connector.operatingPoint().demandW).toBe(Infinity);
      expect(
        callsOf(csms, "StatusNotification").some((f) =>
          statusOf("SuspendedEV")(f),
        ),
      ).toBe(false);
    } finally {
      stop();
      cp.dispose();
      csms.stop();
    }
  }, 15000);
});

describe("vehicle behavior on OCPP 2.0.1 (#835)", () => {
  it("an EV pause is TransactionEvent Updated with chargingState SuspendedEV", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP201-VB", "OCPP-2.0.1");
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    const stop = answerEverythingElse(csms, []);
    try {
      const connector = cp.getConnector(1)!;
      connector.applyEvSettingsOverride({
        vehicleBehavior: { policy: { type: "delayed", delayMs: 60_000 } },
      });
      cp.evPlugIn(1);
      await cp.startTransaction("TAG-VB", 1);
      cp.updateConnectorStatus(1, OCPPStatus.Charging);
      await csms.waitForFrame(
        (f) =>
          callOf("TransactionEvent")(f) &&
          (f[3] as TransactionEventRequestV201).transactionInfo
            ?.chargingState === "SuspendedEV",
        6000,
      );
      expect(connector.status).toBe(OCPPStatus.SuspendedEV);
    } finally {
      stop();
      cp.dispose();
      csms.stop();
    }
  }, 15000);

  const eventOf =
    (eventType: string, triggerReason: string) => (f: OcppFrame) =>
      callOf("TransactionEvent")(f) &&
      (f[3] as TransactionEventRequestV201).eventType === eventType &&
      (f[3] as TransactionEventRequestV201).triggerReason === triggerReason;

  async function stopWhenDoneV201(id: string, txStopPoint?: string) {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, id, "OCPP-2.0.1");
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    if (txStopPoint) cp.configuration.applyChange("TxStopPoint", txStopPoint);
    const stop = answerEverythingElse(csms, []);
    const connector = cp.getConnector(1)!;
    connector.applyEvSettingsOverride({
      vehicleBehavior: {
        preset: "target-soc",
        intent: { targetSoc: 60 },
        stopWhenDone: true,
      },
    });
    cp.evPlugIn(1);
    await cp.startTransaction("TAG-VB-STOP", 1);
    cp.updateConnectorStatus(1, OCPPStatus.Charging);
    connector.soc = 70;
    return { csms, cp, stop, connector };
  }

  // E15.FR.04: a stop the EV asks for is an Ended event with triggerReason
  // StopAuthorized and stoppedReason StoppedByEV (#871).
  it("stopWhenDone ends the transaction with StopAuthorized / StoppedByEV", async () => {
    const { csms, cp, stop } = await stopWhenDoneV201("CP201-VB-STOP");
    try {
      const ended = await csms.waitForFrame(
        (f) =>
          callOf("TransactionEvent")(f) &&
          (f[3] as TransactionEventRequestV201).eventType === "Ended",
        6000,
      );
      const request = ended[3] as TransactionEventRequestV201;
      expect(request.triggerReason).toBe("StopAuthorized");
      expect(request.transactionInfo.stoppedReason).toBe("StoppedByEV");
    } finally {
      stop();
      cp.dispose();
      csms.stop();
    }
  }, 15000);

  // E15.FR.05: with a TxStopPoint lacking Authorized, the EV's stop ends the
  // authorization only: one Updated StopAuthorized, the transaction stays.
  it("stopWhenDone under TxStopPoint EVConnected sends one Updated StopAuthorized", async () => {
    const { csms, cp, stop, connector } = await stopWhenDoneV201(
      "CP201-VB-STOP-EVC",
      "EVConnected",
    );
    try {
      await csms.waitForFrame(eventOf("Updated", "StopAuthorized"), 6000);
      // The vehicle keeps asking on every tick; nothing more goes out.
      await new Promise((r) => setTimeout(r, 2500));
      const updates = callsOf(csms, "TransactionEvent").filter(
        eventOf("Updated", "StopAuthorized"),
      );
      expect(updates).toHaveLength(1);
      expect(
        callsOf(csms, "TransactionEvent").filter(
          (f) => (f[3] as TransactionEventRequestV201).eventType === "Ended",
        ),
      ).toHaveLength(0);
      expect(connector.hasRunningTransaction).toBe(true);
    } finally {
      stop();
      cp.dispose();
      csms.stop();
    }
  }, 15000);
});

describe("power sharing on a station (#608)", () => {
  const caps = (strategy: "equal" | "active") => ({
    connectors: [
      { connectorId: 1, maxDeliveryPowerW: 22_000 },
      { connectorId: 2, maxDeliveryPowerW: 22_000 },
    ],
    powerSharing: { totalPowerW: 22_000, strategy },
  });

  it("active: the share is recalculated when transactions start and stop", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-PS-ACTIVE", "OCPP-1.6J", {
      connectors: 2,
      chargerCapabilities: caps("active"),
    });
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    const stop = answerEverythingElse(csms, ["StartTransaction"]);
    try {
      const [c1, c2] = [cp.getConnector(1)!, cp.getConnector(2)!];
      await startV16(cp, csms, 1, 6081);
      expect(c1.operatingPoint().chargerCapW).toBe(22_000);
      await startV16(cp, csms, 2, 6082);
      expect(c1.operatingPoint().chargerCapW).toBe(11_000);
      expect(c2.operatingPoint().chargerCapW).toBe(11_000);
      cp.stopTransaction(c2);
      await csms.waitForCall("StopTransaction");
      expect(c1.operatingPoint().chargerCapW).toBe(22_000);
    } finally {
      stop();
      cp.dispose();
      csms.stop();
    }
  }, 15000);

  it("equal: the budget is split whether or not the other connector charges", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-PS-EQUAL", "OCPP-1.6J", {
      connectors: 2,
      chargerCapabilities: caps("equal"),
    });
    try {
      expect(cp.getConnector(1)!.operatingPoint().chargerCapW).toBe(11_000);
    } finally {
      cp.dispose();
      csms.stop();
    }
  });

  it("a declared current limit key is accepted by ChangeConfiguration and moves the budget", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-PS-KEY", "OCPP-1.6J", {
      connectors: 2,
      chargerCapabilities: {
        connectors: [
          { connectorId: 1, maxDeliveryPowerW: 22_000 },
          { connectorId: 2, maxDeliveryPowerW: 22_000 },
        ],
        powerSharing: {
          strategy: "equal",
          currentLimit: {
            key: "VendorStationMaxCurrent",
            valueA: 32,
            phases: 3,
          },
        },
      },
    });
    try {
      const c1 = cp.getConnector(1)!;
      expect(c1.operatingPoint().chargerCapW).toBe((32 * 230 * 3) / 2);
      expect(
        cp.configuration.applyChange("VendorStationMaxCurrent", "16"),
      ).toBe("Accepted");
      expect(c1.operatingPoint().chargerCapW).toBe((16 * 230 * 3) / 2);
      // An undeclared vendor key is still not supported (§5.3).
      expect(cp.configuration.applyChange("SomeOtherVendorKey", "16")).toBe(
        "NotSupported",
      );
      // A value outside the key's bounds is refused.
      expect(cp.configuration.applyChange("VendorStationMaxCurrent", "0")).toBe(
        "Rejected",
      );
    } finally {
      cp.dispose();
      csms.stop();
    }
  });

  it("a ChangeConfiguration CALL on the current limit key moves Power.Offered on the wire", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-PS-KEY-WIRE", "OCPP-1.6J", {
      connectors: 2,
      chargerCapabilities: {
        connectors: [
          { connectorId: 1, maxDeliveryPowerW: 22_000 },
          { connectorId: 2, maxDeliveryPowerW: 22_000 },
        ],
        powerSharing: {
          strategy: "equal",
          currentLimit: {
            key: "VendorStationMaxCurrent",
            valueA: 32,
            phases: 3,
          },
        },
      },
    });
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    cp.configuration.applyChange("MeterValuesSampledData", "Power.Offered");
    const stop = answerEverythingElse(csms, ["StartTransaction"]);
    const call = async (id: string, action: string, payload: unknown) => {
      csms.send([2, id, action, payload]);
      return (await csms.waitForFrame(answerTo(id)))[2];
    };
    const offeredW = async (id: string) => {
      const before = csms.received.length - 1;
      expect(
        await call(id, "TriggerMessage", {
          requestedMessage: "MeterValues",
          connectorId: 1,
        }),
      ).toEqual({ status: "Accepted" });
      const frame = await csms.waitForFrame(
        (f) =>
          callOf("MeterValues")(f) &&
          csms.received.indexOf(f) > before &&
          (f[3] as { connectorId: number }).connectorId === 1,
      );
      const { meterValue } = frame[3] as {
        meterValue: {
          sampledValue: { measurand?: string; value: string }[];
        }[];
      };
      const sample = meterValue[0].sampledValue.find(
        (s) => s.measurand === "Power.Offered",
      );
      return Number(sample?.value);
    };
    try {
      cp.getConnector(1)!.applyEvSettingsOverride({ maxChargingPowerKw: 100 });
      await startV16(cp, csms, 1, 6084);
      await csms.waitForFrame(statusOf("Charging"));
      expect(await offeredW("mv-32a")).toBe((32 * 230 * 3) / 2);
      expect(
        await call("cc-16a", "ChangeConfiguration", {
          key: "VendorStationMaxCurrent",
          value: "16",
        }),
      ).toEqual({ status: "Accepted" });
      expect(await offeredW("mv-16a")).toBe((16 * 230 * 3) / 2);
      // Outside the key's bounds: refused, and the budget stays put.
      expect(
        await call("cc-0a", "ChangeConfiguration", {
          key: "VendorStationMaxCurrent",
          value: "0",
        }),
      ).toEqual({ status: "Rejected" });
      expect(await offeredW("mv-0a")).toBe((16 * 230 * 3) / 2);
    } finally {
      stop();
      cp.dispose();
      csms.stop();
    }
  }, 15000);

  it("DC efficiency shows on the main meter's AC input, not on the connector", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-PS-EFF", "OCPP-1.6J", {
      chargerCapabilities: {
        connectors: [
          { connectorId: 1, maxDeliveryPowerW: 50_000, dcEfficiency: 0.9 },
        ],
        mainMeter: {},
      },
    });
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    const stop = answerEverythingElse(csms, ["StartTransaction"]);
    try {
      const c1 = cp.getConnector(1)!;
      c1.applyEvSettingsOverride({
        currentType: "DC",
        voltageV: 400,
        maxChargingPowerKw: 100,
      });
      await startV16(cp, csms, 1, 6083);
      await csms.waitForFrame(statusOf("Charging"));
      const point = c1.operatingPoint();
      expect(point.acceptedW).toBe(50_000);
      expect(point.inputW).toBeCloseTo(50_000 / 0.9);
      const grid = cp.mainMeter!.sampledValues(
        ["Power.Active.Import"],
        "Sample.Periodic",
      );
      expect(Number(grid[0].value)).toBe(Math.round(50_000 / 0.9));
    } finally {
      stop();
      cp.dispose();
      csms.stop();
    }
  }, 15000);
});
