import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { GoldenCase } from "./helpers";
import { both, c16, c201, settle } from "./helpers";

export const bootCases: GoldenCase[] = [
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
];
