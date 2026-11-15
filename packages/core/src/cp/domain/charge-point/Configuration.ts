import type { ChargePoint } from "./ChargePoint";
import {
  DEFAULT_RECONNECT_POLICY,
  retryBackOffDefaults,
} from "../../shared/ReconnectPolicy";
import { OcppFeatureProfile } from "../types/OcppTypes";
import { isOcpp2Version } from "../types/OcppVersion";
import { CoreConfigurationKeys } from "./configurationKeysCore";
import { CustomConfigurationKeys } from "./configurationKeysCustom";

export const ConfigurationKeys = {
  Core: CoreConfigurationKeys,
  Reservation: {
    // If this configuration key is present and set to true: Charge Point support reservations on connector 0.
    ReserveConnectorZeroSupported: {
      name: "ReserveConnectorZeroSupported",
      required: false,
      readonly: true,
      type: "boolean",
    } as BooleanConfigurationKey,
  },
  LocalAuthListManagement: {
    // whether the Local Authorization List is enabled
    LocalAuthListEnabled: {
      name: "LocalAuthListEnabled",
      required: true,
      readonly: false,
      type: "boolean",
    } as BooleanConfigurationKey,
    // Maximum number of identifications that can be stored in the Local Authorization List
    LocalAuthListMaxLength: {
      name: "LocalAuthListMaxLength",
      required: true,
      readonly: true,
      type: "integer",
    } as IntegerConfigurationKey,
    // Maximum number of identifications that can be send in a single SendLocalList.req
    SendLocalListMaxLength: {
      name: "SendLocalListMaxLength",
      required: true,
      readonly: true,
      type: "integer",
    } as IntegerConfigurationKey,
  },
  SmartCharging: {
    // Max StackLevel of a ChargingProfile. The number defined also indicates the max allowed number of installed charging
    // schedules per Charging Profile Purposes.
    ChargeProfileMaxStackLevel: {
      name: "ChargeProfileMaxStackLevel",
      required: true,
      readonly: true,
      type: "integer",
    } as IntegerConfigurationKey,
    // A list of supported quantities for use in a ChargingSchedule. Allowed values: 'Current' and 'Power'
    ChargingScheduleAllowedChargingRateUnit: {
      name: "ChargingScheduleAllowedChargingRateUnit",
      required: true,
      readonly: true,
      type: "array",
    } as ArrayConfigurationKey,
    // Maximum number of periods that may be defined per ChargingSchedule.
    ChargingScheduleMaxPeriods: {
      name: "ChargingScheduleMaxPeriods",
      required: true,
      readonly: true,
      type: "integer",
    } as IntegerConfigurationKey,
    // If defined and true, this Charge Point support switching from 3 to 1 phase during a Transaction.
    ConnectorSwitch3to1PhaseSupported: {
      name: "ConnectorSwitch3to1PhaseSupported",
      required: false,
      readonly: true,
      type: "boolean",
    } as BooleanConfigurationKey,
    // Maximum number of Charging profiles installed at a time
    MaxChargingProfilesInstalled: {
      name: "MaxChargingProfilesInstalled",
      required: true,
      readonly: true,
      type: "integer",
    } as IntegerConfigurationKey,
  },
  SecurityExtension: {
    SecurityProfile: {
      name: "SecurityProfile",
      required: false,
      readonly: false,
      type: "integer",
      min: 0,
      max: 3,
    } as IntegerConfigurationKey,
    AuthorizationKey: {
      name: "AuthorizationKey",
      required: false,
      readonly: false,
      writeonly: true,
      type: "string",
    } as StringConfigurationKey,
    AdditionalRootCertificateCheck: {
      name: "AdditionalRootCertificateCheck",
      required: false,
      readonly: true,
      type: "boolean",
    } as BooleanConfigurationKey,
    CertificateSignedMaxChainSize: {
      name: "CertificateSignedMaxChainSize",
      required: false,
      readonly: true,
      type: "integer",
    } as IntegerConfigurationKey,
    CertificateStoreMaxLength: {
      name: "CertificateStoreMaxLength",
      required: false,
      readonly: true,
      type: "integer",
    } as IntegerConfigurationKey,
    CpoName: {
      name: "CpoName",
      required: false,
      readonly: false,
      type: "string",
    } as StringConfigurationKey,
  },
  Custom: CustomConfigurationKeys,
};

export type ConfigurationKeyType = "integer" | "string" | "boolean" | "array";

export type ConfigurationKey<T = ConfigurationKeyType> = {
  name: string;
  readonly: boolean;
  writeonly?: boolean;
  required: boolean;
  type: T;
  /** Inclusive bounds of an integer key; out of range → `Rejected`. */
  min?: number;
  max?: number;
  /** The only values a string key accepts; anything else → `Rejected`. */
  allowed?: readonly string[];
};
export type IntegerConfigurationKey = ConfigurationKey<"integer">;
export type StringConfigurationKey = ConfigurationKey<"string">;
export type BooleanConfigurationKey = ConfigurationKey<"boolean">;
export type ArrayConfigurationKey = ConfigurationKey<"array">;

export type ConfigurationValueType = number | string | boolean | string[];
export type ConfigurationValue<
  T = ConfigurationKeyType,
  V = ConfigurationValueType,
> = {
  key: ConfigurationKey<T>;
  value: V;
};

export type IntegerConfigurationValue = ConfigurationValue<"integer", number>;
export type StringConfigurationValue = ConfigurationValue<"string", string>;
export type BooleanConfigurationValue = ConfigurationValue<"boolean", boolean>;
export type ArrayConfigurationValue = ConfigurationValue<"array", string[]>;

export type Configuration = ConfigurationValue[];

/**
 * Builds the full set of standard Configuration Keys with sensible defaults.
 *
 * OCPP 1.6 §9 requires every `required: true` key to be returned by
 * GetConfiguration.req — without them CSMS will reject the CP as
 * non-conformant. Profile-specific keys are included for every profile we
 * actually implement (Core / Reservation / SmartCharging / RemoteTrigger),
 * and `SupportedFeatureProfiles` advertises exactly that set.
 */
export const defaultConfiguration: (cp: ChargePoint) => Configuration = (
  cp,
) => {
  const intVal = (
    key: IntegerConfigurationKey,
    value: number,
  ): IntegerConfigurationValue => ({ key, value });
  const boolVal = (
    key: BooleanConfigurationKey,
    value: boolean,
  ): BooleanConfigurationValue => ({ key, value });
  const arrVal = (
    key: ArrayConfigurationKey,
    value: string[],
  ): ArrayConfigurationValue => ({ key, value });
  const strVal = (
    key: StringConfigurationKey,
    value: string,
  ): StringConfigurationValue => ({ key, value });

  // A stand-in without a policy (a test double) gets the built-in one.
  const retryBackOff = retryBackOffDefaults(
    cp.reconnectPolicy ?? DEFAULT_RECONNECT_POLICY,
  );

  return [
    // ── Core profile ────────────────────────────────────────────────────
    boolVal(ConfigurationKeys.Core.AllowOfflineTxForUnknownId, false),
    boolVal(ConfigurationKeys.Core.AuthorizationCacheEnabled, false),
    boolVal(ConfigurationKeys.Core.AuthorizeRemoteTxRequests, false),
    intVal(ConfigurationKeys.Core.ClockAlignedDataInterval, 0),
    intVal(ConfigurationKeys.Core.ConnectionTimeOut, 60),
    arrVal(ConfigurationKeys.Core.ConnectorPhaseRotation, ["NotApplicable"]),
    intVal(ConfigurationKeys.Core.ConnectorPhaseRotationMaxLength, 1),
    intVal(ConfigurationKeys.Core.GetConfigurationMaxKeys, 50),
    intVal(ConfigurationKeys.Core.HeartbeatInterval, 300),
    intVal(ConfigurationKeys.Core.LightIntensity, 100),
    boolVal(ConfigurationKeys.Core.LocalAuthorizeOffline, true),
    boolVal(ConfigurationKeys.Core.LocalPreAuthorize, false),
    intVal(ConfigurationKeys.Core.MaxEnergyOnInvalidId, 0),
    arrVal(ConfigurationKeys.Core.MeterValuesAlignedData, []),
    intVal(ConfigurationKeys.Core.MeterValuesAlignedDataMaxLength, 8),
    arrVal(ConfigurationKeys.Core.MeterValuesSampledData, [
      "Energy.Active.Import.Register",
      // Real charge points also sample instantaneous power; the CSMS uses
      // Power.Active.Import (e.g. low-power / 3kW tariff detection), so emit it
      // by default for realistic CSMS-side testing.
      "Power.Active.Import",
    ]),
    intVal(ConfigurationKeys.Core.MeterValuesSampledDataMaxLength, 8),
    intVal(ConfigurationKeys.Core.MeterValueSampleInterval, 60),
    intVal(ConfigurationKeys.Core.MinimumStatusDuration, 0),
    intVal(ConfigurationKeys.Core.NumberOfConnectors, cp.connectorNumber),
    // ReadWrite on 1.6 and 2.x (OCPP 2.0.1 Part 2 §2.1.14, 2.1 Ed2 §2.1.15).
    intVal(ConfigurationKeys.Core.ResetRetries, 1),
    boolVal(ConfigurationKeys.Core.StopTransactionOnEVSideDisconnect, true),
    boolVal(ConfigurationKeys.Core.StopTransactionOnInvalidId, true),
    arrVal(ConfigurationKeys.Core.StopTxnAlignedData, []),
    intVal(ConfigurationKeys.Core.StopTxnAlignedDataMaxLength, 8),
    arrVal(ConfigurationKeys.Core.StopTxnSampledData, []),
    intVal(ConfigurationKeys.Core.StopTxnSampledDataMaxLength, 8),
    arrVal(ConfigurationKeys.Core.SupportedFeatureProfiles, [
      OcppFeatureProfile.Core,
      OcppFeatureProfile.FirmwareManagement,
      OcppFeatureProfile.LocalAuthListManagement,
      OcppFeatureProfile.Reservation,
      OcppFeatureProfile.SmartCharging,
      OcppFeatureProfile.RemoteTrigger,
    ]),
    intVal(ConfigurationKeys.Core.SupportedFeatureProfilesMaxLength, 6),
    intVal(ConfigurationKeys.Core.TransactionMessageAttempts, 3),
    intVal(ConfigurationKeys.Core.TransactionMessageRetryInterval, 60),
    boolVal(ConfigurationKeys.Core.UnlockConnectorOnEVSideDisconnect, true),
    // #406: only a transport that can send a ping frame claims the key, so
    // SOAP and the browser build answer ChangeConfiguration with NotSupported.
    ...(cp.supportsWebSocketPing
      ? [intVal(ConfigurationKeys.Core.WebSocketPingInterval, 0)]
      : []),

    // ── LocalAuthListManagement profile ────────────────────────────────
    boolVal(
      ConfigurationKeys.LocalAuthListManagement.LocalAuthListEnabled,
      true,
    ),
    intVal(
      ConfigurationKeys.LocalAuthListManagement.LocalAuthListMaxLength,
      1000,
    ),
    intVal(
      ConfigurationKeys.LocalAuthListManagement.SendLocalListMaxLength,
      100,
    ),

    // ── Reservation profile ────────────────────────────────────────────
    boolVal(ConfigurationKeys.Reservation.ReserveConnectorZeroSupported, false),

    // ── SmartCharging profile ──────────────────────────────────────────
    intVal(ConfigurationKeys.SmartCharging.ChargeProfileMaxStackLevel, 10),
    arrVal(
      ConfigurationKeys.SmartCharging.ChargingScheduleAllowedChargingRateUnit,
      ["Current", "Power"],
    ),
    intVal(ConfigurationKeys.SmartCharging.ChargingScheduleMaxPeriods, 24),
    boolVal(
      ConfigurationKeys.SmartCharging.ConnectorSwitch3to1PhaseSupported,
      false,
    ),
    intVal(ConfigurationKeys.SmartCharging.MaxChargingProfilesInstalled, 16),

    // ── Security extension (OCPP 1.6 Security Whitepaper) ──────────────
    intVal(ConfigurationKeys.SecurityExtension.SecurityProfile, 0),
    strVal(ConfigurationKeys.SecurityExtension.AuthorizationKey, ""),
    boolVal(
      ConfigurationKeys.SecurityExtension.AdditionalRootCertificateCheck,
      false,
    ),
    intVal(
      ConfigurationKeys.SecurityExtension.CertificateSignedMaxChainSize,
      4,
    ),
    intVal(ConfigurationKeys.SecurityExtension.CertificateStoreMaxLength, 10),
    strVal(ConfigurationKeys.SecurityExtension.CpoName, ""),

    // ── Custom (non-standard) ──────────────────────────────────────────
    strVal(ConfigurationKeys.Custom.OcppServer, cp.wsUrl),
    strVal(ConfigurationKeys.Custom.SimulatedFirmwareUpdateFailure, ""),
    boolVal(ConfigurationKeys.Custom.AuthorizeBeforeLocalStart, true),
    boolVal(ConfigurationKeys.Custom.AuthorizeRemoteTxRequestsReadOnly, false),
    // #452: 2.x only (AuthCacheCtrlr.LifeTime); a 1.6 GetConfiguration
    // keeps its key set.
    ...(isOcpp2Version(cp.ocppVersion)
      ? [intVal(ConfigurationKeys.Custom.AuthCacheLifeTime, 0)]
      : []),
    // #529: 2.x only (OCPPCommCtrlr.MessageTimeout[Default]), 30 s like the
    // 1.6 serial queue's CALL timeout.
    ...(isOcpp2Version(cp.ocppVersion)
      ? [intVal(ConfigurationKeys.Custom.MessageTimeout, 30)]
      : []),
    // #702: 2.x only (OCPPCommCtrlr.OfflineThreshold, and the simulator's
    // BootOnReconnect option). The spec gives no default threshold: 60 s.
    // #598: 2.x only (AuthCtrlr.MasterPassGroupId); "" = no master pass.
    ...(isOcpp2Version(cp.ocppVersion)
      ? [
          intVal(ConfigurationKeys.Custom.OfflineThreshold, 60),
          boolVal(ConfigurationKeys.Custom.BootOnReconnect, false),
          strVal(ConfigurationKeys.Custom.MasterPassGroupId, ""),
        ]
      : []),
    // #609: 2.x only (OCPPCommCtrlr.RetryBackOff*); the defaults give the
    // reconnect schedule the configured policy gives (1 s doubling to 30 s).
    ...(isOcpp2Version(cp.ocppVersion)
      ? [
          intVal(
            ConfigurationKeys.Custom.RetryBackOffWaitMinimum,
            retryBackOff.waitMinimumSeconds,
          ),
          intVal(
            ConfigurationKeys.Custom.RetryBackOffRandomRange,
            retryBackOff.randomRangeSeconds,
          ),
          intVal(
            ConfigurationKeys.Custom.RetryBackOffRepeatTimes,
            retryBackOff.repeatTimes,
          ),
        ]
      : []),
    // #538: 2.x only (MonitoringCtrlr.OfflineQueuingSeverity); 0 queues
    // only Emergency events while offline.
    ...(isOcpp2Version(cp.ocppVersion)
      ? [intVal(ConfigurationKeys.Custom.OfflineQueuingSeverity, 0)]
      : []),
    // #554: 2.x only; the E11 queue holds at most this many TransactionEvents.
    ...(isOcpp2Version(cp.ocppVersion)
      ? [intVal(ConfigurationKeys.Custom.OfflineQueueMaxEvents, 1000)]
      : []),
    // #537: 2.x only (SecurityCtrlr). CertificateEntries starts at 0; the
    // charge point sets it from its certificate store once both exist.
    ...(isOcpp2Version(cp.ocppVersion)
      ? [
          intVal(ConfigurationKeys.Custom.CertificateEntries, 0),
          intVal(ConfigurationKeys.Custom.MaxCertificateChainSize, 10000),
          intVal(ConfigurationKeys.Custom.CertSigningWaitMinimum, 60),
          intVal(ConfigurationKeys.Custom.CertSigningRepeatTimes, 3),
          boolVal(
            ConfigurationKeys.Custom.AllowSecurityProfileDowngrade,
            false,
          ),
        ]
      : []),
    // #607: 2.x only (SampledDataCtrlr / AlignedDataCtrlr TxEnded* and
    // SendDuringIdle); the defaults add nothing to the messages.
    ...(isOcpp2Version(cp.ocppVersion)
      ? [
          arrVal(ConfigurationKeys.Custom.TxStartPoint, ["Authorized"]),
          arrVal(ConfigurationKeys.Custom.TxStopPoint, [
            "Authorized",
            "EVConnected",
          ]),
          arrVal(ConfigurationKeys.Custom.TxStartedMeasurands, []),
          intVal(ConfigurationKeys.Custom.TxEndedInterval, 0),
          intVal(ConfigurationKeys.Custom.AlignedDataTxEndedInterval, 0),
          boolVal(ConfigurationKeys.Custom.AlignedDataSendDuringIdle, false),
        ]
      : []),
    boolVal(ConfigurationKeys.Custom.SampledDataSignReadings, false),
    strVal(ConfigurationKeys.Custom.SignedMeterDataMode, "valid"),
  ];
};
