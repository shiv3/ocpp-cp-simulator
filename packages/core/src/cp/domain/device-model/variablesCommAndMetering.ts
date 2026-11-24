// Device Model variable table (#604), split out of DeviceModelRegistry.ts
// (#877): OCPPCommCtrlr, TxCtrlr, SampledDataCtrlr, AlignedDataCtrlr and LocalAuthListCtrlr variables.
import type { DeviceModelVariableDef } from "./DeviceModelRegistry";
import { MAX_TIMER_MS } from "../../shared/timers";
import { METER_MEASURANDS, persistent } from "./deviceModelVariableHelpers";

export const COMM_AND_METERING_VARIABLES: readonly DeviceModelVariableDef[] = [
  persistent("OCPPCommCtrlr", "HeartbeatInterval", "HeartbeatInterval", {
    mutability: "ReadWrite",
    dataType: "integer",
    default: 300,
    effect: "The Heartbeat timer restarts with the new interval.",
  }),
  persistent(
    "OCPPCommCtrlr",
    "WebSocketPingInterval",
    "WebSocketPingInterval",
    {
      mutability: "ReadWrite",
      dataType: "integer",
      min: 0,
      max: Math.floor(MAX_TIMER_MS / 1000),
      default: 0,
      effect: "The WebSocket ping timer restarts; 0 disables client pings.",
    },
  ),
  // ReadWrite per OCPP 2.0.1 Part 2 §2.1.14 and 2.1 Ed2 §2.1.15, as on 1.6.
  persistent("OCPPCommCtrlr", "ResetRetries", "ResetRetries", {
    mutability: "ReadWrite",
    dataType: "integer",
    default: 1,
    effect:
      "Stored and reported only: the simulated reset never fails, so nothing retries.",
  }),
  // #490: OCPP 2.0.1 §2.1.10/2.1.11, 2.1 §2.1.12 — variableInstance
  // "TransactionEvent".
  persistent("OCPPCommCtrlr", "MessageAttempts", "TransactionMessageAttempts", {
    instance: "TransactionEvent",
    mutability: "ReadWrite",
    dataType: "integer",
    default: 3,
    effect: "Attempts made to deliver a queued TransactionEvent.",
  }),
  persistent(
    "OCPPCommCtrlr",
    "MessageAttemptInterval",
    "TransactionMessageRetryInterval",
    {
      instance: "TransactionEvent",
      mutability: "ReadWrite",
      dataType: "integer",
      default: 60,
      effect: "Seconds between delivery attempts of a TransactionEvent.",
    },
  ),
  // #529: "DefaultMessageTimeout", variableInstance "Default", seconds.
  persistent("OCPPCommCtrlr", "MessageTimeout", "MessageTimeout", {
    instance: "Default",
    sharedWith16: false,
    mutability: "ReadOnly",
    dataType: "integer",
    min: 1,
    default: 30,
  }),
  // #702: B04.FR.01/02; 2.x only, the spec gives no default.
  persistent("OCPPCommCtrlr", "OfflineThreshold", "OfflineThreshold", {
    sharedWith16: false,
    mutability: "ReadWrite",
    dataType: "integer",
    min: 0,
    default: 60,
    effect:
      "Seconds offline after which a reconnect sends a StatusNotification for every connector.",
  }),
  // #609: Part 4 §5.4 reconnect back-off; 2.x only.
  persistent(
    "OCPPCommCtrlr",
    "RetryBackOffWaitMinimum",
    "RetryBackOffWaitMinimum",
    {
      sharedWith16: false,
      mutability: "ReadWrite",
      dataType: "integer",
      min: 1,
      max: Math.floor(MAX_TIMER_MS / 1000),
      default: 1,
      effect: "Seconds before the first reconnect attempt.",
    },
  ),
  persistent(
    "OCPPCommCtrlr",
    "RetryBackOffRandomRange",
    "RetryBackOffRandomRange",
    {
      sharedWith16: false,
      mutability: "ReadWrite",
      dataType: "integer",
      min: 0,
      max: Math.floor(MAX_TIMER_MS / 1000),
      default: 0,
      effect: "A random extra wait, in seconds, added to every reconnect wait.",
    },
  ),
  persistent(
    "OCPPCommCtrlr",
    "RetryBackOffRepeatTimes",
    "RetryBackOffRepeatTimes",
    {
      sharedWith16: false,
      mutability: "ReadWrite",
      dataType: "integer",
      min: 0,
      max: 30,
      default: 5,
      effect: "How many times the reconnect wait doubles.",
    },
  ),
  persistent("TxCtrlr", "EVConnectionTimeOut", "ConnectionTimeOut", {
    mutability: "ReadWrite",
    dataType: "integer",
    default: 60,
    effect: "Seconds before an incipient transaction is cancelled.",
  }),
  persistent(
    "SampledDataCtrlr",
    "TxUpdatedInterval",
    "MeterValueSampleInterval",
    {
      mutability: "ReadWrite",
      dataType: "integer",
      default: 60,
      effect: "The sampled meter value timer restarts.",
    },
  ),
  persistent(
    "SampledDataCtrlr",
    "TxUpdatedMeasurands",
    "MeterValuesSampledData",
    {
      mutability: "ReadWrite",
      dataType: "MemberList",
      valuesList: METER_MEASURANDS,
      default: ["Energy.Active.Import.Register", "Power.Active.Import"],
      effect: "The measurands of the sampled meter values.",
    },
  ),
  persistent("SampledDataCtrlr", "SignReadings", "SampledDataSignReadings", {
    mutability: "ReadWrite",
    dataType: "boolean",
    default: false,
    effect: "Meter values carry a signed OCMF record.",
  }),
  // #607: transaction-end meter data (Part 2 Appendices ch. 3).
  persistent("SampledDataCtrlr", "TxStartedMeasurands", "TxStartedMeasurands", {
    sharedWith16: false,
    mutability: "ReadWrite",
    dataType: "MemberList",
    valuesList: METER_MEASURANDS,
    default: [],
    effect: "Extra Transaction.Begin samples in TransactionEvent(Started).",
  }),
  persistent("SampledDataCtrlr", "TxEndedMeasurands", "StopTxnSampledData", {
    mutability: "ReadWrite",
    dataType: "MemberList",
    valuesList: METER_MEASURANDS,
    default: [],
    effect: "The sampled measurands TransactionEvent(Ended) carries.",
  }),
  persistent("SampledDataCtrlr", "TxEndedInterval", "TxEndedInterval", {
    sharedWith16: false,
    mutability: "ReadWrite",
    dataType: "integer",
    min: 0,
    max: Math.floor(MAX_TIMER_MS / 1000),
    unit: "s",
    default: 0,
    effect:
      "Seconds between the periodic samples TransactionEvent(Ended) carries.",
  }),
  persistent("AlignedDataCtrlr", "TxEndedMeasurands", "StopTxnAlignedData", {
    mutability: "ReadWrite",
    dataType: "MemberList",
    valuesList: METER_MEASURANDS,
    default: [],
    effect: "The clock-aligned measurands TransactionEvent(Ended) carries.",
  }),
  persistent(
    "AlignedDataCtrlr",
    "TxEndedInterval",
    "AlignedDataTxEndedInterval",
    {
      sharedWith16: false,
      mutability: "ReadWrite",
      dataType: "integer",
      min: 0,
      max: Math.floor(MAX_TIMER_MS / 1000),
      unit: "s",
      default: 0,
      effect: "The clock-aligned grid of the TransactionEvent(Ended) history.",
    },
  ),
  persistent(
    "AlignedDataCtrlr",
    "SendDuringIdle",
    "AlignedDataSendDuringIdle",
    {
      sharedWith16: false,
      mutability: "ReadWrite",
      dataType: "boolean",
      default: false,
      effect: "Clock-aligned meter values are sent only while idle.",
    },
  ),
  persistent("AlignedDataCtrlr", "Interval", "ClockAlignedDataInterval", {
    mutability: "ReadWrite",
    dataType: "integer",
    min: 0,
    max: 86400,
    default: 0,
    effect: "The clock-aligned meter value scheduler restarts.",
  }),
  persistent("AlignedDataCtrlr", "Measurands", "MeterValuesAlignedData", {
    mutability: "ReadWrite",
    dataType: "MemberList",
    valuesList: METER_MEASURANDS,
    default: [],
    effect: "The measurands of the clock-aligned meter values.",
  }),
  persistent("LocalAuthListCtrlr", "Enabled", "LocalAuthListEnabled", {
    mutability: "ReadWrite",
    dataType: "boolean",
    default: true,
    effect: "The local authorization list is consulted or not.",
  }),
  persistent(
    "LocalAuthListCtrlr",
    "ItemsPerMessage",
    "SendLocalListMaxLength",
    {
      mutability: "ReadOnly",
      dataType: "integer",
      default: 100,
    },
  ),
];
