// The simulator's own (Custom) configuration keys (`ConfigurationKeys.Custom`), split out of
// Configuration.ts (#877).
import type {
  BooleanConfigurationKey,
  StringConfigurationKey,
  IntegerConfigurationKey,
  ArrayConfigurationKey,
} from "./Configuration";
import { MAX_TIMER_MS } from "../../shared/timers";
import { SIGNED_METER_MODES } from "../connector/SignedMeterData";
import {
  MAX_MONITOR_SEVERITY,
  MIN_MONITOR_SEVERITY,
} from "../monitoring/VariableMonitor";

export const CustomConfigurationKeys = {
  OcppServer: {
    name: "OcppServer",
    required: false,
    readonly: false,
    type: "string",
  } as StringConfigurationKey,
  // Cert 1.6 Firmware TC_044_2/TC_044_3: pre-arm `simulateFirmwareUpdate`
  // to divert onto a failure status instead of completing the happy
  // path. Set via the scenario `configSet` node before UpdateFirmware
  // fires. "" (default) = no failure injected.
  SimulatedFirmwareUpdateFailure: {
    name: "SimulatedFirmwareUpdateFailure",
    required: false,
    readonly: false,
    type: "string",
  } as StringConfigurationKey,
  // Issue #181: when true (default), a LOCAL (self-initiated, non-
  // remote-start) transaction start sends Authorize.req and awaits
  // Authorize.conf before StartTransaction.req; Invalid/Expired/Blocked
  // refuses the start. Mirrors the official OCTT TC_003/004 flows. Set
  // to false to restore the pre-#181 wire (StartTransaction.req only).
  AuthorizeBeforeLocalStart: {
    name: "AuthorizeBeforeLocalStart",
    required: false,
    readonly: false,
    type: "boolean",
  } as BooleanConfigurationKey,
  // #922: chooses the accessibility of `AuthorizeRemoteTxRequests` (1.6
  // §9.1.3 "R or RW", 2.0.1 Part 2 §2.3.4 `AuthCtrlr.AuthorizeRemoteStart`
  // "ReadOnly or ReadWrite": the choice is the station's). false (default)
  // = read-write, as before; true = ChangeConfiguration / SetVariables of
  // it are Rejected for the CSMS (the operator can still write the value).
  // Applies at once. Not a Device Model variable. Read-only for the CSMS
  // (ChangeConfiguration is Rejected, GetConfiguration says readonly), so
  // a CSMS cannot flip it back; only the operator path (set_config_key,
  // scenario configSet, a persisted override) writes it.
  AuthorizeRemoteTxRequestsReadOnly: {
    name: "AuthorizeRemoteTxRequestsReadOnly",
    required: false,
    readonly: true,
    type: "boolean",
  } as BooleanConfigurationKey,
  // Issue #452: the store key behind OCPP 2.x `AuthCacheCtrlr.LifeTime`
  // (2.0.1 Part 2 §2.4.3, C10.FR.08): seconds an Authorization Cache
  // entry without a cacheExpiryDateTime stays valid after its last
  // update. 0 (default) = no lifetime. 1.6 has no such key, so only 2.x
  // charge points carry it.
  AuthCacheLifeTime: {
    name: "AuthCacheLifeTime",
    required: false,
    readonly: false,
    type: "integer",
    min: 0,
  } as IntegerConfigurationKey,
  // #529: seconds a TransactionEvent may stay unanswered before it counts
  // as a failed transmission (E13). 2.x only, as
  // `OCPPCommCtrlr.MessageTimeout[Default]`, which OCPP 2.0.1 / 2.1 Part 2
  // §2.1.3 "DefaultMessageTimeout" makes ReadOnly (it is set through a
  // NetworkConnectionProfile; SetNetworkProfile stores a profile but does
  // not switch to it).
  MessageTimeout: {
    name: "MessageTimeout",
    required: false,
    readonly: true,
    type: "integer",
    min: 1,
  } as IntegerConfigurationKey,
  // #702: OCPP 2.0.1 / 2.1 OCPPCommCtrlr.OfflineThreshold (Part 2 §2.1.8,
  // Required, ReadWrite, seconds): after an offline period longer than this
  // the station reports all its connectors when it is back (B04.FR.01), else
  // only those whose status changed (B04.FR.02). 2.x only.
  OfflineThreshold: {
    name: "OfflineThreshold",
    required: false,
    readonly: false,
    type: "integer",
    min: 0,
  } as IntegerConfigurationKey,
  // #702: simulator option, 2.x only. false (default): a reconnect after a
  // connection loss sends no BootNotification while the boot data is
  // unchanged (OCPP-J 2.0.1 §5.4); true keeps the BootNotification on every
  // connect.
  BootOnReconnect: {
    name: "BootOnReconnect",
    required: false,
    readonly: false,
    type: "boolean",
  } as BooleanConfigurationKey,
  // #598: OCPP 2.0.1 / 2.1 AuthCtrlr.MasterPassGroupId (Part 2 §2.3): tokens
  // of this group can stop transactions but cannot start one. "" (default)
  // = no master pass. 2.x only.
  MasterPassGroupId: {
    name: "MasterPassGroupId",
    required: false,
    readonly: false,
    type: "string",
  } as StringConfigurationKey,
  // #609: OCPP 2.0.1 / 2.1 OCPPCommCtrlr RetryBackOff* (Part 4 §5.4; variables in the Part 2 Appendices), 2.x
  // only. Seconds to wait before the first reconnect, the random extra
  // wait [0, RandomRange], and how many times the wait doubles.
  RetryBackOffWaitMinimum: {
    name: "RetryBackOffWaitMinimum",
    required: false,
    readonly: false,
    type: "integer",
    min: 1,
    max: Math.floor(MAX_TIMER_MS / 1000),
  } as IntegerConfigurationKey,
  RetryBackOffRandomRange: {
    name: "RetryBackOffRandomRange",
    required: false,
    readonly: false,
    type: "integer",
    min: 0,
    max: Math.floor(MAX_TIMER_MS / 1000),
  } as IntegerConfigurationKey,
  RetryBackOffRepeatTimes: {
    name: "RetryBackOffRepeatTimes",
    required: false,
    readonly: false,
    type: "integer",
    min: 0,
    max: 30,
  } as IntegerConfigurationKey,
  // #538: OCPP 2.0.1 / 2.1 MonitoringCtrlr.OfflineQueuingSeverity (Part 2
  // §2.11.7 / 2.1 §2.13.7, ReadWrite): while offline, NotifyEvents of
  // monitors at or below this severity are queued (N07.FR.04, N08.FR.03).
  // 2.x only.
  OfflineQueuingSeverity: {
    name: "OfflineQueuingSeverity",
    required: false,
    readonly: false,
    type: "integer",
    min: MIN_MONITOR_SEVERITY,
    max: MAX_MONITOR_SEVERITY,
  } as IntegerConfigurationKey,
  // #554: simulator key (no OCPP variable): most TransactionEvents the E11
  // offline queue holds before it drops Updated ones (E11.FR.04/05). 0 =
  // no limit. 2.x only.
  OfflineQueueMaxEvents: {
    name: "OfflineQueueMaxEvents",
    required: false,
    readonly: false,
    type: "integer",
    min: 0,
  } as IntegerConfigurationKey,
  // #537: OCPP 2.x `SecurityCtrlr` variables (2.0.1 / 2.1 Part 2
  // referenced components §2.2.4, §2.2.7-§2.2.9). 1.6 has none of them,
  // so only 2.x charge points carry these keys.
  // CertificateEntries: the number of installed trust anchors, the set
  // M05.FR.06 limits with CertificateStoreMaxLength. ReadOnly; the
  // station keeps it current from its certificate store.
  CertificateEntries: {
    name: "CertificateEntries",
    required: false,
    readonly: true,
    type: "integer",
    min: 0,
  } as IntegerConfigurationKey,
  // A02.FR.16: the largest CertificateSigned `certificateChain`, in
  // characters, the station accepts. The default is the spec's maxLimit
  // and the schema's maxLength, so it refuses nothing a valid frame holds.
  MaxCertificateChainSize: {
    name: "MaxCertificateChainSize",
    required: false,
    readonly: true,
    type: "integer",
    min: 1,
    max: 10000,
  } as IntegerConfigurationKey,
  // A02.FR.17/18: seconds to wait for CertificateSigned after an accepted
  // SignCertificate before resending it; doubled after every resend.
  CertSigningWaitMinimum: {
    name: "CertSigningWaitMinimum",
    required: false,
    readonly: false,
    type: "integer",
    min: 1,
  } as IntegerConfigurationKey,
  // A02.FR.19: how many times SignCertificate is resent before the
  // station waits for a TriggerMessage. 0 = never resent.
  CertSigningRepeatTimes: {
    name: "CertSigningRepeatTimes",
    required: false,
    readonly: false,
    type: "integer",
    min: 0,
  } as IntegerConfigurationKey,
  // OCPP 2.x `SecurityCtrlr.AllowSecurityProfileDowngrade`: when true,
  // SetNetworkProfile accepts a profile with security profile 2 while 3 is
  // in force (B09.FR.04); any other lowering stays Rejected. 2.x only.
  AllowSecurityProfileDowngrade: {
    name: "AllowSecurityProfileDowngrade",
    required: false,
    readonly: false,
    type: "boolean",
  } as BooleanConfigurationKey,
  // #697: `TxCtrlr.TxStartPoint` / `TxStopPoint`, the events that start and
  // end a transaction. 2.x only.
  TxStartPoint: {
    name: "TxStartPoint",
    required: false,
    readonly: false,
    type: "array",
  } as ArrayConfigurationKey,
  TxStopPoint: {
    name: "TxStopPoint",
    required: false,
    readonly: false,
    type: "array",
  } as ArrayConfigurationKey,
  // #607: OCPP 2.x transaction-end metering (Part 2 Appendices, chapter 3).
  // `SampledDataCtrlr.TxStartedMeasurands` lists the measurands of the
  // Started event; empty keeps the energy register alone. 2.x only.
  TxStartedMeasurands: {
    name: "TxStartedMeasurands",
    required: false,
    readonly: false,
    type: "array",
  } as ArrayConfigurationKey,
  // `SampledDataCtrlr.TxEndedInterval` (seconds): how often a sample joins
  // the history that Ended carries; 0 = none. 2.x only.
  TxEndedInterval: {
    name: "TxEndedInterval",
    required: false,
    readonly: false,
    type: "integer",
    min: 0,
    max: Math.floor(MAX_TIMER_MS / 1000),
  } as IntegerConfigurationKey,
  // `AlignedDataCtrlr.TxEndedInterval` (seconds): the clock-aligned grid of
  // that history; 0 = none. 2.x only. (1.6 uses ClockAlignedDataInterval.)
  AlignedDataTxEndedInterval: {
    name: "AlignedDataTxEndedInterval",
    required: false,
    readonly: false,
    type: "integer",
    min: 0,
    max: Math.floor(MAX_TIMER_MS / 1000),
  } as IntegerConfigurationKey,
  // `AlignedDataCtrlr.SendDuringIdle`: when true, clock-aligned MeterValues
  // are sent only for a connector with no transaction. 2.x only.
  AlignedDataSendDuringIdle: {
    name: "AlignedDataSendDuringIdle",
    required: false,
    readonly: false,
    type: "boolean",
  } as BooleanConfigurationKey,
  // #315: sign the energy register in OCMF (German Eichrecht format) and
  // carry it as 1.6 `format: "SignedData"` / 2.x `signedMeterValue`. Off by
  // default; nothing is generated, and no key is made, while false. The
  // name follows the ecosystem's vendor key; 2.x maps
  // `SampledDataCtrlr.SignReadings` onto it.
  SampledDataSignReadings: {
    name: "SampledDataSignReadings",
    required: false,
    readonly: false,
    type: "boolean",
  } as BooleanConfigurationKey,
  // #315: what the next signed record looks like. Anything but `valid` is
  // deliberately wrong, to test a CSMS's rejection path.
  SignedMeterDataMode: {
    name: "SignedMeterDataMode",
    required: false,
    readonly: false,
    type: "string",
    allowed: SIGNED_METER_MODES,
  } as StringConfigurationKey,
};
