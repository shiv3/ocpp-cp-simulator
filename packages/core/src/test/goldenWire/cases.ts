import type { JsonObject } from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import { SIGNING_CERTIFICATE } from "../../cp/domain/security/__tests__/signingCertificateFixture";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import type { WireVersion } from "./FakeCsms";
import type { Rig, RigOptions } from "./rig";

/** One scripted run of a real ChargePoint against the fake CSMS. */
export interface GoldenCase {
  /** Fixture file name; unique across versions. */
  readonly name: string;
  readonly version: WireVersion;
  readonly options?: Partial<Omit<RigOptions, "version">>;
  /** Record with strict normalization (relative timestamps, id shape). */
  readonly strict?: boolean;
  readonly run: (rig: Rig) => Promise<void>;
}

const PAST = "2020-01-01T00:00:00.000Z";

const FUTURE = "2099-01-01T00:00:00.000Z";

const c16 = (
  name: string,
  run: GoldenCase["run"],
  options?: GoldenCase["options"],
): GoldenCase => ({ name: `16-${name}`, version: "1.6", run, options });
const c201 = (
  name: string,
  run: GoldenCase["run"],
  options?: GoldenCase["options"],
): GoldenCase => ({ name: `201-${name}`, version: "2.0.1", run, options });

/** A case that exists on both versions with one body. */
const both = (
  name: string,
  run: GoldenCase["run"],
  options?: GoldenCase["options"],
): GoldenCase[] => [c16(name, run, options), c201(name, run, options)];

const settle = (rig: Rig) => rig.csms.settle();

/** Select `default.firmware` params for the whole case (a code-owned layer). */
const selectFirmware = (cp: ChargePoint, params: JsonObject): void =>
  cp.engine.activateBehavior(
    "default.firmware",
    { kind: "code", behaviorId: "golden" },
    params,
  );

async function charging(rig: Rig, tag = "TAG-1"): Promise<void> {
  rig.plugIn();
  await settle(rig);
  await rig.startLocal(tag);
}

/** Wait for a CP-initiated frame that follows an action, then let it settle. */
async function waitCall(
  rig: Rig,
  action: string,
  from: number,
  nth = 1,
): Promise<void> {
  let seen = 0;
  await rig.csms.waitForFrame(
    (f) => {
      if (f.dir === "CP>" && f.action === action) return ++seen === nth;
      return false;
    },
    { from, timeoutMs: 30_000 },
  );
  await settle(rig);
}

export const goldenCases: GoldenCase[] = [
  // --- boot and status --------------------------------------------------
  ...both("boot", async () => undefined),
  ...both("boot-two-connectors", async () => undefined, { connectors: 2 }),
  ...both(
    "boot-pending-then-triggered",
    async (rig) => {
      // Pending sends nothing more by itself; the CSMS moves the station on
      // with TriggerMessage(BootNotification), which is allowed while Pending.
      await settle(rig);
      rig.cp.sendHeartbeat();
      await settle(rig);
      await rig.csms.call("TriggerMessage", {
        requestedMessage: "BootNotification",
      });
      await rig.csms.waitForCall("BootNotification", {
        nth: 2,
        timeoutMs: 30_000,
      });
      await settle(rig);
    },
    {
      responders: {
        BootNotification: (_p, { nth }) => ({
          result: {
            status: nth === 1 ? "Pending" : "Accepted",
            currentTime: "2030-01-01T00:00:00.000Z",
            interval: 3600,
          },
        }),
      },
    },
  ),
  // OCPP 1.6 section 4.2: while Pending only what a TriggerMessage asks for
  // may be sent; the untriggered Heartbeat stays suppressed.
  c16(
    "boot-pending-triggered-messages",
    async (rig) => {
      await settle(rig);
      rig.cp.sendHeartbeat();
      await settle(rig);
      for (const requestedMessage of [
        "StatusNotification",
        "Heartbeat",
        "MeterValues",
      ]) {
        await rig.csms.call("TriggerMessage", {
          requestedMessage,
          ...(requestedMessage === "Heartbeat" ? {} : { connectorId: 1 }),
        });
        await settle(rig);
      }
    },
    {
      responders: {
        BootNotification: () => ({
          result: {
            status: "Pending",
            currentTime: "2030-01-01T00:00:00.000Z",
            interval: 3600,
          },
        }),
      },
    },
  ),
  ...both(
    "boot-rejected-then-retry",
    async (rig) => {
      await rig.csms.waitForCall("BootNotification", {
        nth: 2,
        timeoutMs: 30_000,
      });
      await settle(rig);
    },
    {
      responders: {
        BootNotification: (_p, { nth }) => ({
          result: {
            status: nth === 1 ? "Rejected" : "Accepted",
            currentTime: "2030-01-01T00:00:00.000Z",
            interval: nth === 1 ? 1 : 3600,
          },
        }),
      },
    },
  ),
  // OCPP 1.6 section 4.2: while Rejected the station answers nothing the CSMS
  // sends and a Reset has no effect; it answers again once the retry
  // BootNotification has been Accepted.
  c16(
    "boot-rejected-silent-then-retry",
    async (rig) => {
      await settle(rig);
      rig.csms.callNoWait("GetConfiguration", { key: ["HeartbeatInterval"] });
      rig.csms.callNoWait("Reset", { type: "Soft" });
      await new Promise((r) => setTimeout(r, 300));
      await rig.csms.waitForCall("BootNotification", {
        nth: 2,
        timeoutMs: 30_000,
      });
      await settle(rig);
      await rig.csms.call("GetConfiguration", { key: ["HeartbeatInterval"] });
      await settle(rig);
    },
    {
      responders: {
        BootNotification: (_p, { nth }) => ({
          result: {
            status: nth === 1 ? "Rejected" : "Accepted",
            currentTime: "2030-01-01T00:00:00.000Z",
            interval: nth === 1 ? 1 : 3600,
          },
        }),
      },
    },
  ),
  ...both(
    "boot-rejected",
    async (rig) => {
      await settle(rig);
    },
    {
      responders: {
        BootNotification: () => ({
          result: {
            status: "Rejected",
            currentTime: "2030-01-01T00:00:00.000Z",
            interval: 3600,
          },
        }),
      },
    },
  ),
  ...both("status-walk", async (rig) => {
    for (const s of [
      OCPPStatus.Preparing,
      OCPPStatus.Charging,
      OCPPStatus.SuspendedEV,
      OCPPStatus.SuspendedEVSE,
      OCPPStatus.Finishing,
      OCPPStatus.Available,
      OCPPStatus.Faulted,
      OCPPStatus.Available,
      OCPPStatus.Unavailable,
      OCPPStatus.Available,
    ]) {
      rig.cp.updateConnectorStatus(1, s);
      await settle(rig);
    }
  }),
  ...both("heartbeat", async (rig) => {
    rig.cp.sendHeartbeat();
    await settle(rig);
  }),
  ...both("trigger-message-all", async (rig) => {
    const t = rig.is16
      ? (m: string) =>
          rig.csms.call("TriggerMessage", {
            requestedMessage: m,
            ...(m === "StatusNotification" || m === "MeterValues"
              ? { connectorId: 1 }
              : {}),
          })
      : (m: string) =>
          rig.csms.call("TriggerMessage", {
            requestedMessage: m,
            ...(m === "StatusNotification" || m === "MeterValues"
              ? { evse: { id: 1, connectorId: 1 } }
              : {}),
          });
    const messages = rig.is16
      ? [
          "BootNotification",
          "Heartbeat",
          "StatusNotification",
          "MeterValues",
          "FirmwareStatusNotification",
          "DiagnosticsStatusNotification",
        ]
      : [
          "BootNotification",
          "Heartbeat",
          "StatusNotification",
          "MeterValues",
          "FirmwareStatusNotification",
          "LogStatusNotification",
          "SignChargingStationCertificate",
        ];
    for (const m of messages) {
      await t(m);
      await settle(rig);
    }
  }),
  // 1.6 section 5.17: a connector that does not exist is Rejected up front
  // for the messages that need one; Heartbeat takes none and is still sent.
  c16("trigger-message-unknown-connector", async (rig) => {
    for (const requestedMessage of ["StatusNotification", "MeterValues"]) {
      await rig.csms.call("TriggerMessage", {
        requestedMessage,
        connectorId: 99,
      });
      await settle(rig);
      await rig.csms.call("ExtendedTriggerMessage", {
        requestedMessage,
        connectorId: 99,
      });
      await settle(rig);
    }
    await rig.csms.call("TriggerMessage", {
      requestedMessage: "Heartbeat",
      connectorId: 99,
    });
    await settle(rig);
  }),
  // F06.FR.06: a triggered MeterValues holds the aligned measurands only and
  // every sampledValue has context Trigger.
  c201("trigger-meter-values-distinct-lists", async (rig) => {
    rig.cp.configuration.applyChange(
      "MeterValuesSampledData",
      "Energy.Active.Import.Register",
    );
    rig.cp.configuration.applyChange(
      "MeterValuesAlignedData",
      "Power.Active.Import",
    );
    await rig.csms.call("TriggerMessage", {
      requestedMessage: "MeterValues",
      evse: { id: 1, connectorId: 1 },
    });
    await settle(rig);
  }),
  ...both("trigger-message-unsupported", async (rig) => {
    await rig.csms.call("TriggerMessage", {
      requestedMessage: "NoSuchMessage",
    });
    await settle(rig);
  }),

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
    rig.cp.stopTransaction(1, "Local");
    await settle(rig);
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
  ...both("vehicle-delayed-suspended-ev", async (rig) => {
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
    await new Promise((resolve) => setTimeout(resolve, 50));
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

  // --- reset -------------------------------------------------------------
  c16("reset-soft-idle", async (rig) => {
    await rig.csms.call("Reset", { type: "Soft" });
    await waitCall(rig, "BootNotification", 0, 2);
  }),
  c16("reset-hard-idle", async (rig) => {
    await rig.csms.call("Reset", { type: "Hard" });
    await waitCall(rig, "BootNotification", 0, 2);
  }),
  c16("reset-soft-charging", async (rig) => {
    await charging(rig);
    await rig.csms.call("Reset", { type: "Soft" });
    await waitCall(rig, "BootNotification", 0, 2);
  }),
  c16("reset-hard-charging", async (rig) => {
    await charging(rig);
    await rig.csms.call("Reset", { type: "Hard" });
    await waitCall(rig, "BootNotification", 0, 2);
  }),
  c201("reset-immediate-idle", async (rig) => {
    await rig.csms.call("Reset", { type: "Immediate" });
    await waitCall(rig, "BootNotification", 0, 2);
  }),
  // B01.FR.09: a reset the operator starts on the station is LocalReset.
  c201("reset-local", async (rig) => {
    rig.cp.reset();
    await waitCall(rig, "BootNotification", 0, 2);
  }),
  c201("reset-immediate-charging", async (rig) => {
    await charging(rig);
    await rig.csms.call("Reset", { type: "Immediate" });
    await waitCall(rig, "BootNotification", 0, 2);
  }),
  c201("reset-onidle-charging", async (rig) => {
    await charging(rig);
    await rig.csms.call("Reset", { type: "OnIdle" });
    await settle(rig);
    rig.cp.stopTransaction(1);
    await settle(rig);
  }),

  // --- firmware, diagnostics, logs --------------------------------------
  c16("update-firmware", async (rig) => {
    const from = rig.csms.mark();
    await rig.csms.call("UpdateFirmware", {
      location: "https://fw.example.test/fw.bin",
      retrieveDate: PAST,
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "FirmwareStatusNotification" &&
        (f.payload as { status?: string }).status === "Installed",
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  c201("update-firmware", async (rig) => {
    await rig.csms.call("UpdateFirmware", {
      requestId: 7,
      firmware: {
        location: "https://fw.example.test/fw.bin",
        retrieveDateTime: PAST,
      },
    });
    await settle(rig);
    await new Promise((r) => setTimeout(r, 2600));
    await settle(rig);
  }),
  c201("update-firmware-simulated-failure-armed", async (rig) => {
    // 2.x UpdateFirmware stays ack-only even with the failure key armed.
    rig.cp.configuration.applyChange(
      "SimulatedFirmwareUpdateFailure",
      "DownloadFailed",
    );
    await rig.csms.call("UpdateFirmware", {
      requestId: 8,
      firmware: {
        location: "https://fw.example.test/fw.bin",
        retrieveDateTime: PAST,
      },
    });
    await settle(rig);
    await new Promise((r) => setTimeout(r, 2600));
    await settle(rig);
  }),
  c16("update-firmware-download-failed", async (rig) => {
    rig.cp.configuration.applyChange(
      "SimulatedFirmwareUpdateFailure",
      "DownloadFailed",
    );
    const from = rig.csms.mark();
    await rig.csms.call("UpdateFirmware", {
      location: "https://fw.example.test/fw.bin",
      retrieveDate: PAST,
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "FirmwareStatusNotification" &&
        (f.payload as { status?: string }).status === "DownloadFailed",
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  c16("update-firmware-install-failed", async (rig) => {
    rig.cp.configuration.applyChange(
      "SimulatedFirmwareUpdateFailure",
      "InstallationFailed",
    );
    const from = rig.csms.mark();
    await rig.csms.call("UpdateFirmware", {
      location: "https://fw.example.test/fw.bin",
      retrieveDate: PAST,
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "FirmwareStatusNotification" &&
        (f.payload as { status?: string }).status === "InstallationFailed",
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  c16("update-firmware-while-in-flight", async (rig) => {
    const from = rig.csms.mark();
    await rig.csms.call("UpdateFirmware", {
      location: "https://fw.example.test/a.bin",
      retrieveDate: PAST,
    });
    // The first download step is a zero-delay timer; wait for it so the second
    // request cannot race its notification.
    await rig.csms.waitForCall("FirmwareStatusNotification", {
      timeoutMs: 5_000,
    });
    await settle(rig);
    await rig.csms.call("UpdateFirmware", {
      location: "https://fw.example.test/b.bin",
      retrieveDate: PAST,
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "FirmwareStatusNotification" &&
        (f.payload as { status?: string }).status === "Installed",
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  c16("signed-update-firmware", async (rig) => {
    const from = rig.csms.mark();
    await rig.csms.call("SignedUpdateFirmware", {
      requestId: 11,
      firmware: {
        location: "https://fw.example.test/signed.bin",
        retrieveDateTime: PAST,
        signingCertificate: SIGNING_CERTIFICATE,
        signature: "c2lnbmF0dXJl",
      },
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "SecurityEventNotification" &&
        (f.payload as { type?: string }).type === "FirmwareUpdated",
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  // #733 L01.FR.23/24/02: a signing certificate that does not parse is
  // answered InvalidCertificate, followed by the security event, and no
  // train runs.
  c16("signed-update-firmware-invalid-certificate", async (rig) => {
    const from = rig.csms.mark();
    await rig.csms.call("SignedUpdateFirmware", {
      requestId: 12,
      firmware: {
        location: "https://fw.example.test/signed.bin",
        retrieveDateTime: PAST,
        signingCertificate:
          "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
        signature: "c2lnbmF0dXJl",
      },
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "SecurityEventNotification" &&
        (f.payload as { type?: string }).type ===
          "InvalidFirmwareSigningCertificate",
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  c16("get-diagnostics", async (rig) => {
    const from = rig.csms.mark();
    await rig.csms.call("GetDiagnostics", { location: rig.uploadUrl() });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "DiagnosticsStatusNotification" &&
        ["Uploaded", "UploadFailed"].includes(
          (f.payload as { status?: string }).status ?? "",
        ),
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  // 1.6 section 4.5 and security whitepaper L01.FR.28/29, N01.FR.12: a
  // triggered status reports the update or upload in progress, Idle otherwise.
  c16("trigger-status-while-busy", async (rig) => {
    const sentStatus =
      (action: string, status: string) =>
      (f: { dir: string; action?: string; payload?: unknown }) =>
        f.dir === "CP>" &&
        f.action === action &&
        (f.payload as { status?: string }).status === status;
    let from = rig.csms.mark();
    await rig.csms.call("SignedUpdateFirmware", {
      requestId: 12,
      firmware: {
        location: "https://fw.example.test/signed.bin",
        retrieveDateTime: PAST,
        signingCertificate: SIGNING_CERTIFICATE,
        signature: "c2lnbmF0dXJl",
      },
    });
    await rig.csms.waitForFrame(
      sentStatus("SignedFirmwareStatusNotification", "Downloaded"),
      { from, timeoutMs: 30_000 },
    );
    await rig.csms.call("ExtendedTriggerMessage", {
      requestedMessage: "FirmwareStatusNotification",
    });
    await settle(rig);
    from = rig.csms.mark();
    await rig.csms.waitForFrame(
      sentStatus("SignedFirmwareStatusNotification", "Installed"),
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
    await rig.csms.call("ExtendedTriggerMessage", {
      requestedMessage: "FirmwareStatusNotification",
    });
    await settle(rig);
    from = rig.csms.mark();
    await rig.csms.call("GetLog", {
      logType: "DiagnosticsLog",
      requestId: 22,
      log: { remoteLocation: rig.uploadUrl() },
    });
    await rig.csms.waitForFrame(
      sentStatus("LogStatusNotification", "Uploading"),
      {
        from,
        timeoutMs: 30_000,
      },
    );
    await rig.csms.call("ExtendedTriggerMessage", {
      requestedMessage: "LogStatusNotification",
    });
    await rig.csms.waitForFrame(
      sentStatus("LogStatusNotification", "Uploaded"),
      {
        from,
        timeoutMs: 30_000,
      },
    );
    await settle(rig);
    await rig.csms.call("ExtendedTriggerMessage", {
      requestedMessage: "LogStatusNotification",
    });
    await settle(rig);
  }),
  c16("get-log", async (rig) => {
    const from = rig.csms.mark();
    await rig.csms.call("GetLog", {
      logType: "DiagnosticsLog",
      requestId: 21,
      log: { remoteLocation: rig.uploadUrl() },
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "LogStatusNotification" &&
        ["Uploaded", "UploadFailure"].includes(
          (f.payload as { status?: string }).status ?? "",
        ),
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  c201("get-log", async (rig) => {
    const from = rig.csms.mark();
    await rig.csms.call("GetLog", {
      logType: "DiagnosticsLog",
      requestId: 21,
      log: { remoteLocation: rig.uploadUrl() },
    });
    // The lifecycle's last status (N01.FR.09), not the 250 ms cut-off.
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "LogStatusNotification" &&
        (f.payload as { status?: string }).status === "Uploaded",
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  c201("firmware-and-log-status-driven", async (rig) => {
    await rig.csms.call("UpdateFirmware", {
      requestId: 5,
      firmware: {
        location: "https://fw.example.test/fw.bin",
        retrieveDateTime: PAST,
      },
    });
    rig.cp.sendFirmwareStatusNotification("Downloading");
    rig.cp.sendFirmwareStatusNotification("Installed");
    await rig.csms.call("GetLog", {
      logType: "SecurityLog",
      requestId: 6,
      log: { remoteLocation: rig.uploadUrl() },
    });
    rig.cp.sendLogStatusNotification("Uploading");
    rig.cp.sendLogStatusNotification("Uploaded");
    // Outlast the automatic lifecycle (2 s): the driven train is the only one
    // that ends with Uploaded (N01.FR.09, #822 review).
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    await settle(rig);
  }),

  // --- opt-in lifecycles (#600, #601) ------------------------------------
  c201(
    "update-firmware-train",
    async (rig) => {
      // train on, a signature present: the whole 2.x train with requestId.
      await rig.csms.call("UpdateFirmware", {
        requestId: 9,
        firmware: {
          location: "https://fw.example.test/fw.bin",
          retrieveDateTime: PAST,
          signingCertificate: SIGNING_CERTIFICATE,
          signature: "sig",
        },
      });
      await rig.csms.waitForCall("SecurityEventNotification", {
        timeoutMs: 30_000,
      });
      await settle(rig);
    },
    { beforeConnect: (cp) => selectFirmware(cp, { train: true, stepMs: 40 }) },
  ),
  c201(
    "update-firmware-train-invalid-signature",
    async (rig) => {
      await rig.csms.call("UpdateFirmware", {
        requestId: 10,
        firmware: {
          location: "https://fw.example.test/fw.bin",
          retrieveDateTime: PAST,
          signingCertificate: SIGNING_CERTIFICATE,
          signature: "sig",
        },
      });
      await rig.csms.waitForCall("SecurityEventNotification", {
        timeoutMs: 30_000,
      });
      await settle(rig);
    },
    {
      beforeConnect: (cp) =>
        selectFirmware(cp, {
          train: true,
          stepMs: 40,
          failAt: "InvalidSignature",
        }),
    },
  ),
  c16(
    "update-firmware-reboot-before-installed",
    async (rig) => {
      await rig.csms.call("UpdateFirmware", {
        location: "http://fw.example.test/fw.bin",
        retrieveDate: PAST,
      });
      await rig.csms.waitForFrame(
        (f) =>
          f.dir === "CP>" &&
          f.action === "FirmwareStatusNotification" &&
          (f.payload as { status?: string }).status === "Installed",
        { timeoutMs: 30_000 },
      );
      await settle(rig);
    },
    {
      beforeConnect: (cp) =>
        selectFirmware(cp, { reboot: "beforeInstalled", stepMs: 40 }),
    },
  ),
  c201("get-log-replaced", async (rig) => {
    const getLog = (requestId: number) =>
      rig.csms.call("GetLog", {
        logType: "DiagnosticsLog",
        requestId,
        log: { remoteLocation: rig.uploadUrl() },
      });
    await getLog(31);
    await new Promise((r) => setTimeout(r, 300));
    await getLog(32);
    await new Promise((r) => setTimeout(r, 2600));
    await settle(rig);
  }),

  // --- availability ------------------------------------------------------
  ...both("change-availability-idle", async (rig) => {
    const change = (type: "Inoperative" | "Operative") =>
      rig.is16
        ? rig.csms.call("ChangeAvailability", { connectorId: 1, type })
        : rig.csms.call("ChangeAvailability", {
            operationalStatus: type,
            evse: { id: 1 },
          });
    await change("Inoperative");
    await settle(rig);
    await change("Operative");
    await settle(rig);
  }),
  ...both("change-availability-scheduled", async (rig) => {
    await charging(rig);
    const change = (type: "Inoperative" | "Operative") =>
      rig.is16
        ? rig.csms.call("ChangeAvailability", { connectorId: 1, type })
        : rig.csms.call("ChangeAvailability", {
            operationalStatus: type,
            evse: { id: 1 },
          });
    await change("Inoperative");
    await settle(rig);
    rig.cp.stopTransaction(1);
    await settle(rig);
    rig.unplug();
    await settle(rig);
    await change("Operative");
    await settle(rig);
  }),
  ...both(
    "change-availability-whole-station",
    async (rig) => {
      if (rig.is16) {
        await rig.csms.call("ChangeAvailability", {
          connectorId: 0,
          type: "Inoperative",
        });
        await settle(rig);
        await rig.csms.call("ChangeAvailability", {
          connectorId: 0,
          type: "Operative",
        });
      } else {
        await rig.csms.call("ChangeAvailability", {
          operationalStatus: "Inoperative",
        });
        await settle(rig);
        await rig.csms.call("ChangeAvailability", {
          operationalStatus: "Operative",
        });
      }
      await settle(rig);
    },
    { connectors: 2 },
  ),

  // --- reservation, unlock ----------------------------------------------
  c16("reserve-cancel", async (rig) => {
    await rig.csms.call("ReserveNow", {
      connectorId: 1,
      expiryDate: FUTURE,
      idTag: "TAG-RES",
      reservationId: 31,
    });
    await settle(rig);
    await rig.csms.call("CancelReservation", { reservationId: 31 });
    await settle(rig);
    await rig.csms.call("CancelReservation", { reservationId: 31 });
    await settle(rig);
  }),
  c201("reserve-cancel", async (rig) => {
    await rig.csms.call("ReserveNow", {
      id: 31,
      expiryDateTime: FUTURE,
      idToken: { idToken: "TAG-RES", type: "ISO14443" },
      evseId: 1,
    });
    await settle(rig);
    await rig.csms.call("CancelReservation", { reservationId: 31 });
    await settle(rig);
    await rig.csms.call("CancelReservation", { reservationId: 31 });
    await settle(rig);
  }),
  c16("reserve-then-use-reserved-tag", async (rig) => {
    await rig.csms.call("ReserveNow", {
      connectorId: 1,
      expiryDate: FUTURE,
      idTag: "TAG-RES",
      reservationId: 32,
    });
    await settle(rig);
    rig.plugIn();
    await settle(rig);
    await rig.startLocal("TAG-RES");
    rig.cp.stopTransaction(1);
    await settle(rig);
  }),
  c16("reserve-occupied", async (rig) => {
    await charging(rig);
    await rig.csms.call("ReserveNow", {
      connectorId: 1,
      expiryDate: FUTURE,
      idTag: "TAG-RES",
      reservationId: 33,
    });
    await settle(rig);
  }),
  ...both("unlock-connector", async (rig) => {
    await rig.csms.call(
      "UnlockConnector",
      rig.is16 ? { connectorId: 1 } : { evseId: 1, connectorId: 1 },
    );
    await settle(rig);
  }),
  ...both("unlock-connector-charging", async (rig) => {
    await charging(rig);
    await rig.csms.call(
      "UnlockConnector",
      rig.is16 ? { connectorId: 1 } : { evseId: 1, connectorId: 1 },
    );
    await settle(rig);
  }),
  ...both("unlock-unknown-connector", async (rig) => {
    await rig.csms.call(
      "UnlockConnector",
      rig.is16 ? { connectorId: 9 } : { evseId: 9, connectorId: 1 },
    );
    await settle(rig);
  }),

  // --- inbound policy and response override ----------------------------
  ...both("inbound-policy-callerror", async (rig) => {
    rig.cp.setInboundCallPolicy("UnlockConnector", {
      kind: "callerror",
      errorCode: "NotSupported",
      errorDescription: "policy says no",
    });
    await rig.csms.call(
      "UnlockConnector",
      rig.is16 ? { connectorId: 1 } : { evseId: 1, connectorId: 1 },
    );
    await settle(rig);
    rig.cp.clearInboundCallPolicy("UnlockConnector");
    await rig.csms.call(
      "UnlockConnector",
      rig.is16 ? { connectorId: 1 } : { evseId: 1, connectorId: 1 },
    );
    await settle(rig);
  }),
  ...both("inbound-policy-ignore", async (rig) => {
    rig.cp.setInboundCallPolicy("TriggerMessage", { kind: "ignore" });
    rig.csms.callNoWait(
      "TriggerMessage",
      rig.is16
        ? { requestedMessage: "Heartbeat" }
        : { requestedMessage: "Heartbeat" },
    );
    await settle(rig);
  }),
  ...both("response-override", async (rig) => {
    rig.cp.armResponseOverride("UnlockConnector", "Failed");
    const payload = rig.is16
      ? { connectorId: 1 }
      : { evseId: 1, connectorId: 1 };
    await rig.csms.call("UnlockConnector", payload);
    await settle(rig);
    // one-shot: the second call is answered by the real handler
    await rig.csms.call("UnlockConnector", payload);
    await settle(rig);
  }),
  c16("response-override-remote-start-rejected", async (rig) => {
    rig.cp.armResponseOverride("RemoteStartTransaction", "Rejected");
    await rig.csms.call("RemoteStartTransaction", {
      idTag: "TAG-X",
      connectorId: 1,
    });
    await settle(rig);
  }),
  c201("response-override-alias", async (rig) => {
    // armed under the 1.6 spelling, consumed by the 2.x call
    rig.cp.armResponseOverride("RemoteStartTransaction", "Rejected");
    await rig.csms.call("RequestStartTransaction", {
      idToken: { idToken: "TAG-X", type: "ISO14443" },
      remoteStartId: 2,
      evseId: 1,
    });
    await settle(rig);
  }),
  ...both("unknown-action", async (rig) => {
    await rig.csms.call("NoSuchAction", {});
    await settle(rig);
  }),
  c201("malformed-payload", async (rig) => {
    await rig.csms.call("UnlockConnector", { evseId: "one" });
    await settle(rig);
  }),

  // --- configuration, data transfer, misc -------------------------------
  c16("configuration", async (rig) => {
    await rig.csms.call("GetConfiguration", {});
    await rig.csms.call("GetConfiguration", {
      key: ["HeartbeatInterval", "NoSuchKey"],
    });
    await rig.csms.call("ChangeConfiguration", {
      key: "MeterValueSampleInterval",
      value: "30",
    });
    await rig.csms.call("ChangeConfiguration", {
      key: "NoSuchKey",
      value: "1",
    });
    await settle(rig);
  }),
  c201("variables", async (rig) => {
    await rig.csms.call("GetVariables", {
      getVariableData: [
        {
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
        },
        {
          component: { name: "NoSuchCtrlr" },
          variable: { name: "Nope" },
        },
      ],
    });
    await rig.csms.call("SetVariables", {
      setVariableData: [
        {
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
          attributeValue: "120",
        },
      ],
    });
    await settle(rig);
  }),
  ...both("data-transfer", async (rig) => {
    await rig.csms.call("DataTransfer", { vendorId: "com.example" });
    rig.cp.sendDataTransfer("com.example.cp", "ping", "payload");
    await settle(rig);
  }),
  ...both("clear-cache", async (rig) => {
    await rig.csms.call("ClearCache", {});
    await settle(rig);
  }),
  c16("local-list", async (rig) => {
    await rig.csms.call("GetLocalListVersion", {});
    await rig.csms.call("SendLocalList", {
      listVersion: 1,
      updateType: "Full",
      localAuthorizationList: [
        { idTag: "LOCAL-1", idTagInfo: { status: "Accepted" } },
      ],
    });
    await rig.csms.call("GetLocalListVersion", {});
    await settle(rig);
  }),
  c201("local-list", async (rig) => {
    await rig.csms.call("GetLocalListVersion", {});
    await rig.csms.call("SendLocalList", {
      versionNumber: 1,
      updateType: "Full",
      localAuthorizationList: [
        {
          idToken: { idToken: "LOCAL-1", type: "ISO14443" },
          idTokenInfo: { status: "Accepted" },
        },
      ],
    });
    await rig.csms.call("GetLocalListVersion", {});
    await settle(rig);
  }),
  c16("smart-charging", async (rig) => {
    await charging(rig);
    await rig.csms.call("SetChargingProfile", {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 1,
        stackLevel: 0,
        chargingProfilePurpose: "TxDefaultProfile",
        chargingProfileKind: "Absolute",
        chargingSchedule: {
          chargingRateUnit: "W",
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
        },
      },
    });
    await rig.csms.call("GetCompositeSchedule", {
      connectorId: 1,
      duration: 600,
    });
    await rig.csms.call("ClearChargingProfile", { id: 1 });
    await settle(rig);
  }),
  // 1.6 §7.21, errata 3.25 / 3.26: Unknown when nothing matched; an id
  // overrides connectorId and stackLevel.
  c16("clear-charging-profile-unknown", async (rig) => {
    await charging(rig);
    await rig.csms.call("ClearChargingProfile", { id: 99 });
    await rig.csms.call("ClearChargingProfile", {});
    await rig.csms.call("SetChargingProfile", {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 1,
        stackLevel: 3,
        chargingProfilePurpose: "TxDefaultProfile",
        chargingProfileKind: "Absolute",
        chargingSchedule: {
          chargingRateUnit: "W",
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
        },
      },
    });
    await rig.csms.call("ClearChargingProfile", {
      id: 1,
      connectorId: 2,
      stackLevel: 9,
    });
    await settle(rig);
  }),
  // 1.6 §7.13 startSchedule/duration, errata 3.43: the ended stack-2 profile
  // yields to stack 0, then an Absolute profile counts from startSchedule.
  c16("smart-charging-start-schedule", async (rig) => {
    await charging(rig);
    const profile = (
      id: number,
      stackLevel: number,
      schedule: Record<string, unknown>,
    ) =>
      rig.csms.call("SetChargingProfile", {
        connectorId: 1,
        csChargingProfiles: {
          chargingProfileId: id,
          stackLevel,
          chargingProfilePurpose: "TxDefaultProfile",
          chargingProfileKind: "Absolute",
          chargingSchedule: { chargingRateUnit: "W", ...schedule },
        },
      });
    await profile(1, 0, {
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
    });
    await profile(2, 2, {
      startSchedule: "2020-01-01T00:00:00Z",
      duration: 3600,
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 3000 }],
    });
    await rig.csms.call("GetCompositeSchedule", {
      connectorId: 1,
      duration: 600,
    });
    await profile(3, 3, {
      startSchedule: "2020-01-01T00:00:00Z",
      chargingSchedulePeriod: [
        { startPeriod: 0, limit: 11000 },
        { startPeriod: 100_000_000, limit: 2000 },
      ],
    });
    await rig.csms.call("GetCompositeSchedule", {
      connectorId: 1,
      duration: 600,
    });
    await settle(rig);
  }),
  c201("smart-charging", async (rig) => {
    await charging(rig);
    await rig.csms.call("SetChargingProfile", {
      evseId: 1,
      chargingProfile: {
        id: 1,
        stackLevel: 0,
        chargingProfilePurpose: "TxDefaultProfile",
        chargingProfileKind: "Absolute",
        chargingSchedule: [
          {
            id: 1,
            chargingRateUnit: "W",
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
          },
        ],
      },
    });
    await rig.csms.call("GetCompositeSchedule", {
      evseId: 1,
      duration: 600,
    });
    await rig.csms.call("ClearChargingProfile", { chargingProfileId: 1 });
    await settle(rig);
  }),

  // 2.0.1 K01.FR.09 / .33 / .52 / .53: a TxProfile needs the EVSE's running
  // transaction; a TxDefaultProfile cannot repeat a stack level across EVSE 0
  // and a specific EVSE under another id.
  c201("set-charging-profile-preconditions", async (rig) => {
    const profile = (
      evseId: number,
      id: number,
      purpose: string,
      extra: Record<string, unknown> = {},
      stackLevel = 1,
    ) => ({
      evseId,
      chargingProfile: {
        id,
        stackLevel,
        chargingProfilePurpose: purpose,
        chargingProfileKind: "Absolute",
        ...extra,
        chargingSchedule: [
          {
            id,
            chargingRateUnit: "W",
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
          },
        ],
      },
    });
    await rig.csms.call(
      "SetChargingProfile",
      profile(1, 1, "TxProfile", { transactionId: "no-such-transaction" }),
    );
    await charging(rig);
    await rig.csms.call(
      "SetChargingProfile",
      profile(1, 1, "TxProfile", { transactionId: "other-transaction" }),
    );
    await rig.csms.call(
      "SetChargingProfile",
      profile(1, 2, "TxProfile", { transactionId: rig.transactionId(1) }),
    );
    await rig.csms.call(
      "SetChargingProfile",
      profile(1, 3, "TxDefaultProfile", {}, 5),
    );
    await rig.csms.call(
      "SetChargingProfile",
      profile(0, 4, "TxDefaultProfile", {}, 5),
    );
    await rig.csms.call(
      "SetChargingProfile",
      profile(0, 5, "TxDefaultProfile", {}, 6),
    );
    await rig.csms.call(
      "SetChargingProfile",
      profile(1, 6, "TxDefaultProfile", {}, 6),
    );
    await settle(rig);
  }),

  // 2.0.1 K09.FR.02 / K09.FR.04: an EVSE query reports only that EVSE's
  // profiles (one report); the unscoped query sends one report per EVSE and
  // marks every report but the last with tbc.
  c201(
    "get-charging-profiles-scope-tbc",
    async (rig) => {
      const install = (evseId: number, id: number) =>
        rig.csms.call("SetChargingProfile", {
          evseId,
          chargingProfile: {
            id,
            stackLevel: id,
            chargingProfilePurpose: "TxDefaultProfile",
            chargingProfileKind: "Absolute",
            chargingSchedule: [
              {
                id,
                chargingRateUnit: "W",
                chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
              },
            ],
          },
        });
      await install(0, 1);
      await install(2, 2);
      await rig.csms.call("GetChargingProfiles", {
        requestId: 1,
        evseId: 2,
        chargingProfile: {},
      });
      await settle(rig);
      await rig.csms.call("GetChargingProfiles", {
        requestId: 2,
        chargingProfile: {},
      });
      await settle(rig);
    },
    { connectors: 2 },
  ),

  // 2.0.1 K01.FR.30 / K01.FR.36: validFrom, validTo and startSchedule are
  // stored and reported apart; an absent one stays absent.
  c201("charging-profile-times", async (rig) => {
    const profile = (
      id: number,
      times: Record<string, string>,
      scheduleTimes: Record<string, string>,
    ) => ({
      evseId: 1,
      chargingProfile: {
        id,
        stackLevel: id,
        chargingProfilePurpose: "TxDefaultProfile",
        chargingProfileKind: "Absolute",
        ...times,
        chargingSchedule: [
          {
            id,
            ...scheduleTimes,
            chargingRateUnit: "W",
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
          },
        ],
      },
    });
    await rig.csms.call(
      "SetChargingProfile",
      profile(
        1,
        { validFrom: "2099-01-09T00:00:00Z", validTo: "2099-02-09T00:00:00Z" },
        { startSchedule: "2099-01-01T00:00:00Z" },
      ),
    );
    await rig.csms.call(
      "SetChargingProfile",
      profile(2, {}, { startSchedule: "2099-01-01T00:00:00Z" }),
    );
    await rig.csms.call("GetChargingProfiles", {
      requestId: 1,
      chargingProfile: {},
    });
    await settle(rig);
  }),

  // --- connection loss ---------------------------------------------------
  ...both("csms-drops-connection", async (rig) => {
    rig.csms.dropConnection();
    await rig.reconnected();
    await settle(rig);
  }),
  ...both("cp-disconnect-connect", async (rig) => {
    rig.cp.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    await rig.connectAndBoot();
  }),
  ...both("transaction-stopped-while-offline", async (rig) => {
    await charging(rig);
    rig.cp.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    rig.cp.stopTransaction(1);
    await new Promise((r) => setTimeout(r, 100));
    await rig.connectAndBoot();
    await settle(rig);
  }),
  ...both("csms-silent-then-reconnect", async (rig) => {
    rig.cp.setInboundCallPolicy("DataTransfer", { kind: "ignore" });
    rig.csms.callNoWait("DataTransfer", { vendorId: "com.example" });
    await settle(rig);
    rig.csms.dropConnection();
    await rig.reconnected();
    await settle(rig);
  }),
];

function rig16or201(p: Record<string, unknown>): Record<string, unknown> {
  const tag = (p.idTag ??
    (p.idToken as { idToken?: string } | undefined)?.idToken) as string;
  const status = tag?.startsWith("CERT023-INV") ? "Invalid" : "Accepted";
  return "idTag" in p ? { idTagInfo: { status } } : { idTokenInfo: { status } };
}
