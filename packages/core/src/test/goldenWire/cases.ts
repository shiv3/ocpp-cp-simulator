import { SIGNING_CERTIFICATE } from "../../cp/domain/security/__tests__/signingCertificateFixture";
import { bootCases } from "./cases/boot";
import { firmwareCases } from "./cases/firmware";
import {
  type GoldenCase,
  both,
  c16,
  c201,
  charging,
  FUTURE,
  PAST,
  selectFirmware,
  settle,
} from "./cases/helpers";
import { resetCases } from "./cases/reset";
import { transactionCases } from "./cases/transactions";

export type { GoldenCase } from "./cases/helpers";

export const goldenCases: GoldenCase[] = [
  ...bootCases,
  ...transactionCases,
  ...resetCases,
  ...firmwareCases,

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
  // #605: one case per report base (B07.FR.07-FR.09), then a full report
  // split by ItemsPerMessage into parts linked by seqNo / tbc (B07.FR.10).
  ...(
    ["ConfigurationInventory", "FullInventory", "SummaryInventory"] as const
  ).map((reportBase) =>
    c201(`base-report-${reportBase}`, async (rig) => {
      await rig.csms.call("GetBaseReport", { requestId: 1, reportBase });
      await rig.csms.waitForCall("NotifyReport", { timeoutMs: 30_000 });
      await settle(rig);
    }),
  ),
  c201("base-report-chunked", async (rig) => {
    rig.cp.configuration.defineRuntimeIntegerKey(
      "ItemsPerMessageGetReport",
      15,
      {
        min: 1,
      },
    );
    await rig.csms.call("GetBaseReport", {
      requestId: 2,
      reportBase: "FullInventory",
    });
    await rig.csms.waitForCall("NotifyReport", { nth: 3, timeoutMs: 30_000 });
    await settle(rig);
  }),
  // B09 SetNetworkProfile: a valid profile is Accepted and stored with no
  // reconnect; invalid content and a security downgrade are Rejected with a
  // reasonCode (B09.FR.01/02/04).
  c201("set-network-profile", async (rig) => {
    const connectionData = {
      ocppVersion: "OCPP20",
      ocppTransport: "JSON",
      ocppCsmsUrl: "wss://csms.example/ocpp/",
      messageTimeout: 30,
      securityProfile: 2,
      ocppInterface: "Wired0",
    };
    await rig.csms.call("SetNetworkProfile", {
      configurationSlot: 1,
      connectionData,
    });
    await rig.csms.call("SetNetworkProfile", {
      configurationSlot: 2,
      connectionData: { ...connectionData, ocppTransport: "SOAP" },
    });
    rig.cp.configuration.applyChange("SecurityProfile", "3", {
      bypassGuard: true,
    });
    await rig.csms.call("SetNetworkProfile", {
      configurationSlot: 2,
      connectionData,
    });
    await rig.csms.call("SetVariables", {
      setVariableData: [
        {
          component: { name: "SecurityCtrlr" },
          variable: { name: "AllowSecurityProfileDowngrade" },
          attributeValue: "true",
        },
      ],
    });
    await rig.csms.call("SetNetworkProfile", {
      configurationSlot: 2,
      connectionData,
    });
    await settle(rig);
  }),
  // DeviceDataCtrlr.ConfigurationValueSize / ReportingValueSize: an
  // oversized SetVariables value is Rejected / TooLargeElement, and a
  // reported value is cut to ReportingValueSize.
  c201("variables-value-size", async (rig) => {
    // Lowered from the schema's maxLength, which the frame validation
    // already enforces.
    rig.cp.configuration.defineRuntimeIntegerKey("ConfigurationValueSize", 8);
    rig.cp.configuration.defineRuntimeIntegerKey("ReportingValueSize", 4);
    const master = {
      component: { name: "AuthCtrlr" },
      variable: { name: "MasterPassGroupId" },
    };
    await rig.csms.call("SetVariables", {
      setVariableData: [
        { ...master, attributeValue: "GROUP-123" },
        { ...master, attributeValue: "GROUP-12" },
      ],
    });
    await rig.csms.call("GetVariables", {
      getVariableData: [
        master,
        {
          component: { name: "DeviceDataCtrlr" },
          variable: { name: "ConfigurationValueSize" },
        },
      ],
    });
    await settle(rig);
  }),
  // #606: reason codes (B05.FR.07-FR.09, B06.FR.09) and the DeviceDataCtrlr
  // size limits (B05.FR.11, B06.FR.05) in the statusInfo of each result.
  c201("variables-reason-codes", async (rig) => {
    const heartbeat = {
      component: { name: "OCPPCommCtrlr" },
      variable: { name: "HeartbeatInterval" },
    };
    await rig.csms.call("SetVariables", {
      setVariableData: [
        {
          component: { name: "LocalAuthListCtrlr" },
          variable: { name: "ItemsPerMessage" },
          attributeValue: "50",
        },
        { ...heartbeat, attributeValue: "soon" },
        {
          component: { name: "AlignedDataCtrlr" },
          variable: { name: "Interval" },
          attributeValue: "86401",
        },
        {
          component: { name: "ChargingStation" },
          variable: { name: "AvailabilityState" },
          attributeValue: "Nope",
        },
        { ...heartbeat, attributeValue: "60", attributeType: "MaxSet" },
        { ...heartbeat, attributeValue: "60" },
      ],
    });
    await rig.csms.call("GetVariables", {
      getVariableData: [
        {
          component: { name: "DeviceDataCtrlr" },
          variable: { name: "ItemsPerMessage", instance: "SetVariables" },
        },
        {
          component: { name: "DeviceDataCtrlr" },
          variable: { name: "BytesPerMessage", instance: "GetVariables" },
        },
      ],
    });
    await settle(rig);
  }),
  c201("variables-too-many-elements", async (rig) => {
    const heartbeat = {
      component: { name: "OCPPCommCtrlr" },
      variable: { name: "HeartbeatInterval" },
    };
    await rig.csms.call("SetVariables", {
      setVariableData: Array.from({ length: 101 }, () => ({
        ...heartbeat,
        attributeValue: "60",
      })),
    });
    await rig.csms.call("GetVariables", {
      getVariableData: Array.from({ length: 101 }, () => heartbeat),
    });
    await settle(rig);
  }),
  c201("variables-too-large", async (rig) => {
    const heartbeat = {
      component: { name: "OCPPCommCtrlr" },
      variable: { name: "HeartbeatInterval" },
    };
    await rig.csms.call("SetVariables", {
      // attributeValue is capped at 1000 characters by the schema: 70 of
      // them pass the item limit (100) and exceed the byte limit (65536).
      setVariableData: Array.from({ length: 70 }, () => ({
        ...heartbeat,
        attributeValue: "9".repeat(1000),
      })),
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
  // #697: TxStartPoint / TxStopPoint drive the TransactionEvent timing. The
  // defaults (Authorized / Authorized,EVConnected) are every other 201 case.
  // EVConnected start: Started at the plug-in, the tag is an Updated event.
  c201("tx-start-ev-connected-local", async (rig) => {
    rig.cp.configuration.applyChange("TxStartPoint", "EVConnected");
    rig.cp.evPlugIn(1);
    await rig.csms.waitForCall("TransactionEvent");
    await settle(rig);
    await rig.startLocal("TAG-1");
    await settle(rig);
    rig.cp.stopTransaction(1);
    await settle(rig);
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  c201("tx-start-ev-connected-remote", async (rig) => {
    rig.cp.configuration.applyChange("TxStartPoint", "EVConnected");
    await settle(rig);
    rig.cp.evPlugIn(1);
    await rig.csms.waitForCall("TransactionEvent");
    await settle(rig);
    await rig.remoteStart();
    await rig.remoteStop();
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  // Review of #960: EVConnected alone does not start at the authorization. A
  // tag before the plug-in is authorized and waits; the plug-in starts the
  // transaction (Started CablePluggedIn) and the token follows as Updated.
  c201("tx-start-ev-connected-tag-before-plugin", async (rig) => {
    rig.cp.configuration.applyChange("TxStartPoint", "EVConnected");
    await settle(rig);
    await rig.startLocal("TAG-1");
    await settle(rig);
    rig.cp.evPlugIn(1);
    await settle(rig);
    rig.cp.stopTransaction(1);
    await settle(rig);
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  c201("tx-start-ev-connected-remote-before-plugin", async (rig) => {
    rig.cp.configuration.applyChange("TxStartPoint", "EVConnected");
    await settle(rig);
    await rig.remoteStart();
    await settle(rig);
    rig.cp.evPlugIn(1);
    await rig.csms.waitForCall("TransactionEvent");
    await settle(rig);
    await settle(rig);
    await rig.remoteStop();
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  // The earlier of the two starts: here the plug-in.
  c201("tx-start-authorized-or-ev-connected", async (rig) => {
    rig.cp.configuration.applyChange("TxStartPoint", "Authorized,EVConnected");
    rig.cp.evPlugIn(1);
    await rig.csms.waitForCall("TransactionEvent");
    await settle(rig);
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  // A cable that leaves before any tag ends the transaction it started.
  // F03.FR.02 / C15.FR.03: without Authorized in TxStopPoint a remote stop
  // is an Updated event and the unplug ends the transaction.
  c201("tx-stop-ev-connected-remote-stop", async (rig) => {
    rig.cp.configuration.applyChange("TxStopPoint", "EVConnected");
    rig.cp.evPlugIn(1);
    await settle(rig);
    await rig.startLocal("TAG-1");
    await rig.remoteStop();
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  // Review of #960: a stop that is not an authorization ending (a reason such
  // as EVDisconnected, no trigger reason) ends the transaction (Ended).
  c201("tx-stop-ev-connected-behavior-stop", async (rig) => {
    rig.cp.configuration.applyChange("TxStopPoint", "EVConnected");
    rig.cp.evPlugIn(1);
    await settle(rig);
    await rig.startLocal("TAG-1");
    await settle(rig);
    rig.cp.stopTransaction(1, "EVDisconnected");
    await settle(rig);
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  // C15.FR.03: a deauthorization with TxStopPoint EVConnected is an Updated
  // event (triggerReason Deauthorized); the unplug ends the transaction.
  c201("tx-stop-ev-connected-deauthorized", async (rig) => {
    rig.cp.configuration.applyChange("TxStopPoint", "EVConnected");
    rig.csms.responders["TransactionEvent"] = (p: { eventType?: string }) =>
      p.eventType === "Started" ? { idTokenInfo: { status: "Invalid" } } : {};
    rig.plugIn();
    await settle(rig);
    await rig.cp.startTransaction("TAG-A", 1);
    await settle(rig);
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
];
