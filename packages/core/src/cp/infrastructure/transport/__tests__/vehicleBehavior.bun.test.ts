import { describe, expect, it } from "bun:test";
import type { TransactionEventRequestV201 } from "@ocpp-cp-simulator/ocpp/index";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
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
