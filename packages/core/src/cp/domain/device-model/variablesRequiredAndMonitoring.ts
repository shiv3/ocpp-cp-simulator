// Device Model variable table (#604), split out of DeviceModelRegistry.ts
// (#877): Required variables (#704), DeviceDataCtrlr limits and MonitoringCtrlr variables.
import type { DeviceModelVariableDef } from "./DeviceModelRegistry";
import {
  CONFIGURATION_VALUE_MAX_SIZE,
  DEVICE_DATA_CTRLR_KEYS,
  REPORTING_VALUE_MAX_SIZE,
  REPORT_MAX_BYTES,
  REPORT_MAX_ITEMS,
  VARIABLES_REQUEST_MAX_BYTES,
  VARIABLES_REQUEST_MAX_ITEMS,
} from "./deviceDataCtrlrKeys";
import {
  MONITORING_CTRLR_KEYS,
  MONITORING_REQUEST_MAX_BYTES,
  MONITORING_REQUEST_MAX_ITEMS,
} from "../monitoring/monitoringCtrlrKeys";
import { MONITORING_BASES } from "../monitoring/MonitoringStore";
import {
  RUNTIME_VALUE_KEYS,
  V2_CONNECTOR_STATUSES,
} from "../charge-point/runtimeValueKeys";
import { persistent, runtime } from "./deviceModelVariableHelpers";

export const REQUIRED_AND_MONITORING_VARIABLES: readonly DeviceModelVariableDef[] =
  [
    // #704: variables Part 2 §2 marks "Required yes". Each is ReadOnly unless
    // the simulator has behavior behind a write (#604 rule, #569).
    // §2.2: the profile in force; upgrading by SetVariables would need the
    // A05 reconnect, which only ChangeConfiguration (1.6) drives, so ReadOnly.
    persistent("SecurityCtrlr", "SecurityProfile", "SecurityProfile", {
      mutability: "ReadOnly",
      dataType: "integer",
      min: 0,
      max: 3,
      default: 0,
    }),
    // §2.2: the CPO name; the simulator puts it in no certificate request, so
    // ReadOnly. Shares the 1.6 key CpoName.
    persistent("SecurityCtrlr", "OrganizationName", "CpoName", {
      mutability: "ReadOnly",
      dataType: "string",
      default: "",
    }),
    // A01.FR.01/02: the password the next connection uses for HTTP Basic
    // authentication. It is the 1.6 AuthorizationKey; never readable.
    persistent("SecurityCtrlr", "BasicAuthPassword", "AuthorizationKey", {
      mutability: "WriteOnly",
      dataType: "string",
      // 16-40 characters on 2.x (A00.FR.202, whitepaper §7.2). A monitor could
      // leak the secret through NotifyEvent actualValue, so none is allowed.
      maxLimit: 40,
      supportsMonitoring: false,
      default: "",
      effect:
        "The next connection authenticates with it (HTTP Basic, profiles 1 and 2).",
    }),
    // §2.1: the file transfer is simulated (no bytes move), so the station
    // names the two protocols a CSMS location normally uses.
    runtime("OCPPCommCtrlr", "FileTransferProtocols", "FileTransferProtocols", {
      dataType: "MemberList",
      valuesList: ["HTTP", "HTTPS"],
      default: "HTTP,HTTPS",
      constant: true,
    }),
    // §2.1: 1.6 UnlockConnectorOnEVSideDisconnect; the simulated connector
    // has no lock to release, so it is reported and not writable.
    persistent(
      "OCPPCommCtrlr",
      "UnlockOnEVSideDisconnect",
      "UnlockConnectorOnEVSideDisconnect",
      { mutability: "ReadOnly", dataType: "boolean", default: true },
    ),
    // §2.5: the station's own clock, read live; the time comes from the
    // CSMS (BootNotification / Heartbeat), so the only source is Heartbeat.
    runtime("ClockCtrlr", "DateTime", RUNTIME_VALUE_KEYS.clockDateTime, {
      dataType: "dateTime",
    }),
    runtime("ClockCtrlr", "TimeSource", "ClockTimeSource", {
      dataType: "OptionList",
      valuesList: ["Heartbeat"],
      default: "Heartbeat",
      constant: true,
    }),
    // §2.4 (with the local list): how many entries the list holds.
    runtime(
      "LocalAuthListCtrlr",
      "Entries",
      RUNTIME_VALUE_KEYS.localAuthListEntries,
      { dataType: "integer", min: 0 },
    ),
    // #605: the size of the NotifyReport parts of GetBaseReport / GetReport.
    runtime(
      "DeviceDataCtrlr",
      "ItemsPerMessage",
      DEVICE_DATA_CTRLR_KEYS.itemsPerGetReport,
      {
        instance: "GetReport",
        dataType: "integer",
        min: 1,
        default: REPORT_MAX_ITEMS,
        constant: true,
      },
    ),
    runtime(
      "DeviceDataCtrlr",
      "BytesPerMessage",
      DEVICE_DATA_CTRLR_KEYS.bytesPerGetReport,
      {
        instance: "GetReport",
        dataType: "integer",
        min: 1,
        default: REPORT_MAX_BYTES,
        constant: true,
      },
    ),
    // #606: the request limits GetVariables / SetVariables enforce
    // (B05.FR.11, B06.FR.05); constants of the simulated station.
    ...(
      [
        ["GetVariables", "itemsPerGetVariables", "bytesPerGetVariables"],
        ["SetVariables", "itemsPerSetVariables", "bytesPerSetVariables"],
      ] as const
    ).flatMap(([message, items, bytes]) => [
      runtime(
        "DeviceDataCtrlr",
        "ItemsPerMessage",
        DEVICE_DATA_CTRLR_KEYS[items],
        {
          instance: message,
          dataType: "integer",
          default: VARIABLES_REQUEST_MAX_ITEMS,
          constant: true,
        },
      ),
      runtime(
        "DeviceDataCtrlr",
        "BytesPerMessage",
        DEVICE_DATA_CTRLR_KEYS[bytes],
        {
          instance: message,
          dataType: "integer",
          default: VARIABLES_REQUEST_MAX_BYTES,
          constant: true,
        },
      ),
    ]),
    // Part 2 DeviceDataCtrlr: the longest value the station takes in a
    // SetVariables (longer is Rejected / TooLargeElement) and the longest it
    // reports (GetVariables, NotifyReport; longer is truncated). Constants at
    // the schema's maxLength, so a CSMS reading them knows what to expect.
    runtime(
      "DeviceDataCtrlr",
      "ConfigurationValueSize",
      DEVICE_DATA_CTRLR_KEYS.configurationValueSize,
      {
        dataType: "integer",
        min: 1,
        max: CONFIGURATION_VALUE_MAX_SIZE,
        default: CONFIGURATION_VALUE_MAX_SIZE,
        constant: true,
      },
    ),
    runtime(
      "DeviceDataCtrlr",
      "ReportingValueSize",
      DEVICE_DATA_CTRLR_KEYS.reportingValueSize,
      {
        dataType: "integer",
        min: 1,
        max: REPORTING_VALUE_MAX_SIZE,
        default: REPORTING_VALUE_MAX_SIZE,
        constant: true,
      },
    ),
    // #538: MonitoringCtrlr (2.0.1 Part 2 §2.11.3-§2.11.9, 2.1 §2.13.3-§2.13.9).
    runtime(
      "MonitoringCtrlr",
      "ItemsPerMessage",
      MONITORING_CTRLR_KEYS.itemsPerSetVariableMonitoring,
      {
        instance: "SetVariableMonitoring",
        dataType: "integer",
        default: MONITORING_REQUEST_MAX_ITEMS,
      },
    ),
    runtime(
      "MonitoringCtrlr",
      "BytesPerMessage",
      MONITORING_CTRLR_KEYS.bytesPerSetVariableMonitoring,
      {
        instance: "SetVariableMonitoring",
        dataType: "integer",
        default: MONITORING_REQUEST_MAX_BYTES,
      },
    ),
    runtime(
      "MonitoringCtrlr",
      "ItemsPerMessage",
      MONITORING_CTRLR_KEYS.itemsPerClearVariableMonitoring,
      {
        instance: "ClearVariableMonitoring",
        dataType: "integer",
        default: MONITORING_REQUEST_MAX_ITEMS,
      },
    ),
    runtime(
      "MonitoringCtrlr",
      "BytesPerMessage",
      MONITORING_CTRLR_KEYS.bytesPerClearVariableMonitoring,
      {
        instance: "ClearVariableMonitoring",
        dataType: "integer",
        default: MONITORING_REQUEST_MAX_BYTES,
      },
    ),
    runtime(
      "MonitoringCtrlr",
      "ActiveMonitoringLevel",
      MONITORING_CTRLR_KEYS.activeMonitoringLevel,
      { dataType: "integer", min: 0, max: 9 },
    ),
    runtime(
      "MonitoringCtrlr",
      "ActiveMonitoringBase",
      MONITORING_CTRLR_KEYS.activeMonitoringBase,
      { dataType: "OptionList", valuesList: MONITORING_BASES },
    ),
    // #538: §2.11.7 "OfflineMonitoringEventQueuingSeverity", ReadWrite.
    persistent(
      "MonitoringCtrlr",
      "OfflineQueuingSeverity",
      "OfflineQueuingSeverity",
      {
        sharedWith16: false,
        mutability: "ReadWrite",
        dataType: "integer",
        min: 0,
        max: 9,
        default: 0,
        effect:
          "Monitoring events up to this severity are queued while offline.",
      },
    ),
    runtime(
      "ChargingStation",
      "AvailabilityState",
      RUNTIME_VALUE_KEYS.chargingStationAvailabilityState,
      { dataType: "OptionList", valuesList: V2_CONNECTOR_STATUSES },
    ),
  ];
