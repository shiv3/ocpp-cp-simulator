import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { GoldenCase } from "./helpers";
import { both, bothVirtual, charging, rig16or201, settle } from "./helpers";

export const transactionCases: GoldenCase[] = [
  // --- authorize and transactions ---------------------------------------
  ...both("authorize", async (rig) => {
    rig.cp.authorize("TAG-AUTH");
    await settle(rig);
  }),
  ...both(
    "authorize-invalid",
    async (rig) => {
      rig.cp.authorize("CERT023-INV");
      await settle(rig);
    },
    {
      responders: {
        Authorize: (p) => ({
          result: rig16or201(p),
        }),
      },
    },
  ),
  ...both("local-start-stop", async (rig) => {
    await charging(rig);
    rig.cp.stopTransaction(1);
    await settle(rig);
    rig.unplug();
    await settle(rig);
  }),
  ...both("local-start-meter-stop", async (rig) => {
    await charging(rig);
    rig.cp.setMeterValue(1, 1500);
    rig.cp.sendMeterValue(1);
    await settle(rig);
    rig.cp.setMeterValue(1, 4200);
    rig.cp.sendMeterValue(1);
    await settle(rig);
    await rig.stopAndSettle(1, "Local");
  }),
  // #327: a charger cap of 11 kW on a 22 kW three-phase vehicle. Power.Offered
  // and Power.Active.Import both read the capped value (one operating point),
  // per phase on three phases; with the vehicle at 22 kW and no cap they
  // would read 22 kW.
  // #614-#617: opt-in meter realism and the station main meter. Only the
  // deterministic parts are pinned (no fluctuation or ramp: those read the
  // wall clock). Per-phase voltages, independent legs, Interval / Export
  // samples, unit overrides (kWh, a multiplier on 2.0.1) and a main meter on
  // connector 0 / EVSE 0 that aggregates the connector.
  ...both(
    "meter-realism-values",
    async (rig) => {
      await charging(rig);
      const connector = rig.cp.getConnector(1)!;
      if (connector.status !== OCPPStatus.Charging) {
        rig.cp.updateConnectorStatus(1, OCPPStatus.Charging);
        await settle(rig);
      }
      connector.evSettings = {
        ...connector.evSettings,
        maxChargingPowerKw: 11,
        currentType: "AC",
        phases: 3,
        voltageV: 230,
      };
      rig.cp.configuration.applyChange(
        "MeterValuesSampledData",
        "Energy.Active.Import.Register,Energy.Active.Import.Interval,Energy.Active.Export.Register,Power.Active.Import,Power.Active.Export,Voltage,Current.Import",
      );
      rig.cp.setMeterValue(1, 1500);
      rig.cp.sendMeterValue(1);
      await settle(rig);
      rig.cp.setMeterValue(1, 4200);
      rig.cp.sendMeterValue(1);
      rig.cp.sendMeterValue(0);
      await settle(rig);
      rig.cp.stopTransaction(1, "Local");
      await settle(rig);
    },
    {
      transportOptions: {
        chargerCapabilities: {
          connectors: [
            {
              connectorId: 1,
              maxDeliveryPowerW: 22_000,
              meter: {
                phases: {},
                sampledValues: [
                  {
                    measurand: "Energy.Active.Import.Register",
                    set: { unit: "kWh" },
                  },
                  {
                    measurand: "Power.Active.Import",
                    phase: "L2",
                    set: { omit: true },
                  },
                ],
              },
            },
          ],
          mainMeter: {},
        },
      },
    },
  ),
  ...both("charger-cap-meter-values", async (rig) => {
    await charging(rig);
    const connector = rig.cp.getConnector(1)!;
    // 2.0.1 leaves the connector in Preparing until the EVSE energizes it.
    if (connector.status !== OCPPStatus.Charging) {
      rig.cp.updateConnectorStatus(1, OCPPStatus.Charging);
      await settle(rig);
    }
    connector.evSettings = {
      ...connector.evSettings,
      maxChargingPowerKw: 22,
      currentType: "AC",
      phases: 3,
      voltageV: 230,
    };
    connector.setMaxDeliveryPowerW(11_000);
    rig.cp.configuration.applyChange(
      "MeterValuesSampledData",
      "Energy.Active.Import.Register,Power.Active.Import,Power.Offered,Current.Import",
    );
    rig.cp.setMeterValue(1, 1500);
    rig.cp.sendMeterValue(1);
    await settle(rig);
    rig.cp.stopTransaction(1, "Local");
    await settle(rig);
  }),
  // #835: the vehicle's demand is a term of the operating point. An 11 kW
  // vehicle that cut its own demand to 3.7 kW is delivered 3.7 kW while the
  // offer stays the EVSE's: Power.Active.Import and Current.Import follow the
  // demand, Power.Offered does not.
  ...both("vehicle-demand-meter-values", async (rig) => {
    await charging(rig);
    const connector = rig.cp.getConnector(1)!;
    if (connector.status !== OCPPStatus.Charging) {
      rig.cp.updateConnectorStatus(1, OCPPStatus.Charging);
      await settle(rig);
    }
    connector.evSettings = {
      ...connector.evSettings,
      maxChargingPowerKw: 11,
      currentType: "AC",
      phases: 3,
      voltageV: 230,
      vehicleBehavior: {
        policy: {
          type: "demand-steps",
          steps: [{ afterMs: 0, maxPowerW: 3_700 }],
        },
      },
    };
    rig.cp.configuration.applyChange(
      "MeterValuesSampledData",
      "Energy.Active.Import.Register,Power.Active.Import,Power.Offered,Current.Import",
    );
    rig.cp.setMeterValue(1, 1500);
    rig.cp.sendMeterValue(1);
    await settle(rig);
    rig.cp.stopTransaction(1, "Local");
    await settle(rig);
  }),
  // #835: a vehicle that has not started asking for energy is SuspendedEV
  // with the transaction running (1.6 §4.9 C4; 2.0.1 chargingState
  // SuspendedEV), through the readiness operation of #453.
  ...bothVirtual("vehicle-delayed-suspended-ev", async (rig, turn) => {
    rig.cp.getConnector(1)!.applyEvSettingsOverride({
      vehicleBehavior: { policy: { type: "delayed", delayMs: 3_600_000 } },
    });
    // The vehicle's clock starts at the plug-in; 2.0.1 does not imply a cable
    // for a transaction that starts first (E03).
    rig.cp.evPlugIn(1);
    await settle(rig);
    await rig.startLocal("TAG-1");
    // 2.0.1 leaves the connector in Preparing until the EVSE energizes it.
    if (rig.cp.getConnector(1)!.status === OCPPStatus.Preparing) {
      rig.cp.updateConnectorStatus(1, OCPPStatus.Charging);
    }
    // The vehicle reacts to the status change after the event, on the next
    // turn of the clock; 2.0.1 sends nothing for Preparing to Charging, so
    // there is no traffic for `settle` to wait for.
    await turn();
    await settle(rig);
    rig.cp.stopTransaction(1, "Local");
    await settle(rig);
  }),
  // #608: a station budget shared between connectors narrows the offer; one
  // connector holds the whole budget.
  ...both(
    "power-sharing-meter-values",
    async (rig) => {
      await charging(rig);
      const connector = rig.cp.getConnector(1)!;
      if (connector.status !== OCPPStatus.Charging) {
        rig.cp.updateConnectorStatus(1, OCPPStatus.Charging);
        await settle(rig);
      }
      connector.evSettings = {
        ...connector.evSettings,
        maxChargingPowerKw: 22,
        currentType: "AC",
        phases: 3,
        voltageV: 230,
      };
      rig.cp.configuration.applyChange(
        "MeterValuesSampledData",
        "Energy.Active.Import.Register,Power.Active.Import,Power.Offered,Current.Import",
      );
      rig.cp.setMeterValue(1, 1500);
      rig.cp.sendMeterValue(1);
      await settle(rig);
      rig.cp.stopTransaction(1, "Local");
      await settle(rig);
    },
    {
      transportOptions: {
        chargerCapabilities: {
          connectors: [{ connectorId: 1, maxDeliveryPowerW: 22_000 }],
          powerSharing: { totalPowerW: 5_500, strategy: "active" },
        },
      },
    },
  ),
  ...both(
    "start-denied-by-authorize",
    async (rig) => {
      rig.plugIn();
      await settle(rig);
      await rig.cp.startTransaction("CERT023-INV", 1);
      await settle(rig);
    },
    {
      responders: {
        Authorize: (p) => ({ result: rig16or201(p) }),
        StartTransaction: () => ({
          result: {
            transactionId: 9001,
            idTagInfo: { status: "Invalid" },
          },
        }),
      },
    },
  ),
  ...both("remote-start-stop", async (rig) => {
    rig.plugIn();
    await settle(rig);
    await rig.remoteStart();
    await rig.remoteStop();
    rig.unplug();
    await settle(rig);
  }),
  ...both("remote-start-no-plug", async (rig) => {
    await rig.remoteStart();
    await rig.remoteStop();
  }),
  ...both("remote-stop-unknown-transaction", async (rig) => {
    if (rig.is16) {
      await rig.csms.call("RemoteStopTransaction", { transactionId: 424242 });
    } else {
      await rig.csms.call("RequestStopTransaction", {
        transactionId: "no-such-transaction",
      });
    }
    await settle(rig);
  }),
  // #453: the EV and cable model. A plug-in reports Preparing (2.x Occupied)
  // by itself, readiness suspends and resumes the transaction, an unplug of
  // an idle connector returns to Available.
  ...both("ev-cable-plug-unplug-idle", async (rig) => {
    rig.cp.evPlugIn(1);
    rig.cp.evPlugIn(1);
    await settle(rig);
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  ...both("ev-cable-ready-cycle", async (rig) => {
    rig.cp.evPlugIn(1);
    await settle(rig);
    await rig.startLocal("TAG-A", 1);
    await settle(rig);
    // 2.x leaves the connector status to the caller once the start is sent.
    if (!rig.is16) rig.cp.updateConnectorStatus(1, OCPPStatus.Charging);
    await settle(rig);
    rig.cp.evSetReady(1, false);
    await settle(rig);
    rig.cp.evSetReady(1, true);
    await settle(rig);
    rig.cp.stopTransaction(1);
    await settle(rig);
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  ...both("ev-disconnect-during-transaction", async (rig) => {
    await charging(rig);
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  ...both(
    "two-connectors-transactions",
    async (rig) => {
      rig.plugIn(1);
      rig.plugIn(2);
      await settle(rig);
      await rig.startLocal("TAG-A", 1);
      await rig.startLocal("TAG-B", 2);
      rig.cp.setMeterValue(1, 100);
      rig.cp.sendMeterValue(1);
      rig.cp.setMeterValue(2, 200);
      rig.cp.sendMeterValue(2);
      await settle(rig);
      rig.cp.stopTransaction(2);
      await settle(rig);
      rig.cp.stopTransaction(1);
      await settle(rig);
    },
    { connectors: 2 },
  ),
  ...both("meter-value-no-transaction", async (rig) => {
    rig.cp.setMeterValue(1, 777);
    rig.cp.sendMeterValue(1);
    await settle(rig);
  }),
];
