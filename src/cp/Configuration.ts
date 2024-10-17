import { ChargePoint } from "./ChargePoint.ts";
import { OcppFeatureProfile } from "./OcppTypes.ts";

export const ConfigurationKeys = {
  Core: {
    // If this key exists, the Charge Point supports Unknown Offline Authorization.
    // If this key reports a value of true, Unknown Offline Authorization is enabled.
    AllowOfflineTxForUnknownId: {
      name: "AllowOfflineTxForUnknownId",
      required: false,
      readonly: false,
      type: "boolean"
    } as BooleanConfigurationKey,
    // If this key exists, the Charge Point supports an Authorization Cache.
    // If this key reports a value of true, the Authorization Cache is enabled.
    AuthorizationCacheEnabled: {
      name: "AuthorizationCacheEnabled",
      required: false,
      readonly: false,
      type: "boolean"
    } as BooleanConfigurationKey,
    // Whether a remote request to start a transaction in the form of a RemoteStartTransaction.req message should be
    // authorized beforehand like a local action to start a transaction.
    AuthorizeRemoteTxRequests: {
      name: "AuthorizeRemoteTxRequests",
      required: true,
      readonly: true, // Choice is up to Charge Point implementation
      type: "boolean"
    } as BooleanConfigurationKey,
    // Number of times to blink Charge Point lighting when signalling
    BlinkRepeat: {
      name: "BlinkRepeat",
      required: false,
      readonly: false,
      type: "integer"
    } as IntegerConfigurationKey,
    // Size (in seconds) of the clock-aligned data interval. This is the size (in seconds) of the set of evenly spaced
    // aggregation intervals per day, starting at 00:00:00 (midnight).
    // For example, a value of 900 (15 minutes) indicates that every day should be broken into 96 15-minute intervals.
    // When clock aligned data is being transmitted, the interval in question is identified by the start time
    // and (optional) duration interval value, represented according to the ISO8601 standard.
    // All "per-period" data (e.g. energy readings) should be accumulated (for "flow" type measurands such as energy),
    // or averaged (for other values) across the entire interval (or partial interval, at the beginning
    // or end of a Transaction), and transmitted (if so enabled) at the end of each interval,
    // bearing the interval start time timestamp.
    // A value of "0" (numeric zero), by convention, is to be interpreted to mean that no clock-aligned data
    // should be transmitted.
    ClockAlignedDataInterval: {
      name: "ClockAlignedDataInterval",
      required: true,
      readonly: false,
      type: "integer"
    } as IntegerConfigurationKey,
    // Interval (in seconds) *from beginning of status: 'Preparing' until incipient Transaction is automatically canceled,
    // due to failure of EV driver to (correctly) insert the charging cable connector(s) into the appropriate socket(s).
    // The Charge Point SHALL go back to the original state, probably: 'Available'.
    ConnectionTimeOut: {
      name: "ConnectionTimeOut",
      required: true,
      readonly: false,
      type: "integer"
    } as IntegerConfigurationKey,
    // The phase rotation per connector in respect to the connector’s electrical meter (or if absent, the grid connection).
    // Possible values per connector are:
    // NotApplicable (for Single phase or DC Charge Points)
    // Unknown (not (yet) known)
    // RST (Standard Reference Phasing)
    // RTS (Reversed Reference Phasing)
    // SRT (Reversed 240 degree rotation)
    // STR (Standard 120 degree rotation)
    // TRS (Standard 240 degree rotation)
    // TSR (Reversed 120 degree rotation)
    // R can be identified as phase 1 (L1), S as phase 2 (L2), T as phase 3 (L3).
    // If known, the Charge Point MAY also report the phase rotation between the grid connection and the main energymeter
    // by using index number Zero (0).
    // Values are reported in CSL, formatted: 0.RST, 1.RST, 2.RTS
    ConnectorPhaseRotation: {
      name: "ConnectorPhaseRotation",
      required: true,
      readonly: false,
      type: "array"
    } as ArrayConfigurationKey,
    // Maximum number of items in a ConnectorPhaseRotation Configuration Key.
    ConnectorPhaseRotationMaxLength: {
      name: "ConnectorPhaseRotationMaxLength",
      required: false,
      readonly: true,
      type: "integer"
    } as IntegerConfigurationKey,
    // Maximum number of requested configuration keys in a GetConfiguration.req PDU.
    GetConfigurationMaxKeys: {
      name: "GetConfigurationMaxKeys",
      required: true,
      readonly: true,
      type: "integer"
    } as IntegerConfigurationKey,
    // Interval (in seconds) of inactivity (no OCPP exchanges) with central system after which the Charge Point
    // should send a Heartbeat.req PDU
    HeartbeatInterval: {
      name: "HeartbeatInterval",
      required: true,
      readonly: false,
      type: "integer"
    } as IntegerConfigurationKey,
    // Percentage of maximum intensity at which to illuminate Charge Point lighting
    LightIntensity: {
      name: "LightIntensity",
      required: false,
      readonly: false,
      type: "integer"
    } as IntegerConfigurationKey,
    // whether the Charge Point, when offline, will start a transaction for locally-authorized identifiers.
    LocalAuthorizeOffline: {
      name: "LocalAuthorizeOffline",
      required: true,
      readonly: false,
      type: "boolean"
    } as BooleanConfigurationKey,
    // whether the Charge Point, when online, will start a transaction for locally-authorized identifiers
    // without waiting for or requesting an Authorize.conf from the Central System
    LocalPreAuthorize: {
      name: "LocalPreAuthorize",
      required: true,
      readonly: false,
      type: "boolean"
    } as BooleanConfigurationKey,
    // Maximum energy (in Wh) delivered when an identifier is invalidated by the Central System after start of a transaction.
    MaxEnergyOnInvalidId: {
      name: "MaxEnergyOnInvalidId",
      required: false,
      readonly: false,
      type: "integer"
    } as IntegerConfigurationKey,
    // Clock-aligned measurand(s) to be included in a MeterValues.req PDU, every ClockAlignedDataInterval seconds
    MeterValuesAlignedData: {
      name: "MeterValuesAlignedData",
      required: true,
      readonly: true,
      type: "array"
    } as ArrayConfigurationKey,
    // Maximum number of items in a MeterValuesAlignedData Configuration Key.
    MeterValuesAlignedDataMaxLength: {
      name: "MeterValuesAlignedDataMaxLength",
      required: false,
      readonly: true,
      type: "integer"
    } as IntegerConfigurationKey,
    // Sampled measurands to be included in a MeterValues.req PDU, every MeterValueSampleInterval seconds.
    // Where applicable, the Measurand is combined with the optional phase; for instance: Voltage.L1
    // Default: "Energy.Active.Import.Register"
    MeterValuesSampledData: {
      name: "MeterValuesSampledData",
      required: true,
      readonly: false,
      type: "array"
    } as ArrayConfigurationKey,
    // Maximum number of items in a MeterValuesSampledData Configuration Key.
    MeterValuesSampledDataMaxLength: {
      name: "MeterValuesSampledDataMaxLength",
      required: false,
      readonly: true,
      type: "integer"
    } as IntegerConfigurationKey,
    // Interval (in seconds) between sampling of metering (or other) data, intended to be transmitted
    // by "MeterValues" PDUs. For charging session data (ConnectorId>0), samples are acquired and transmitted
    // periodically at this interval from the start of the charging transaction.
    // A value of "0" (numeric zero), by convention, is to be interpreted to mean that no sampled data should be transmitted.
    MeterValueSampleInterval: {
      name: "MeterValueSampleInterval",
      required: true,
      readonly: false,
      type: "integer"
    } as IntegerConfigurationKey,
    // The minimum duration (in seconds) that a Charge Point or Connector status is stable before
    // a StatusNotification.req PDU is sent to the Central System.
    MinimumStatusDuration: {
      name: "MinimumStatusDuration",
      required: false,
      readonly: false,
      type: "integer"
    } as IntegerConfigurationKey,
    // The number of physical charging connectors of this Charge Point.
    NumberOfConnectors: {
      name: "NumberOfConnectors",
      required: true,
      readonly: true,
      type: "integer"
    } as IntegerConfigurationKey,
    // Number of times to retry an unsuccessful reset of the Charge Point.
    ResetRetries: {
      name: "ResetRetries",
      required: true,
      readonly: false,
      type: "integer"
    } as IntegerConfigurationKey,
    // When set to true, the Charge Point SHALL administratively stop the transaction
    // when the cable is unplugged from the EV.
    StopTransactionOnEVSideDisconnect: {
      name: "StopTransactionOnEVSideDisconnect",
      required: true,
      readonly: false,
      type: "boolean"
    } as BooleanConfigurationKey,
    // whether the Charge Point will stop an ongoing transaction when it receives a non-Accepted authorization status
    // in a StartTransaction.conf for this transaction
    StopTransactionOnInvalidId: {
      name: "StopTransactionOnInvalidId",
      required: true,
      readonly: false,
      type: "boolean"
    } as BooleanConfigurationKey,
    // Clock-aligned periodic measurand(s) to be included in the TransactionData element of StopTransaction.req
    // MeterValues.req PDU for every ClockAlignedDataInterval of the Transaction
    StopTxnAlignedData: {
      name: "StopTxnAlignedData",
      required: true,
      readonly: false,
      type: "array"
    } as ArrayConfigurationKey,
    // Maximum number of items in a StopTxnAlignedData Configuration Key.
    StopTxnAlignedDataMaxLength: {
      name: "StopTxnAlignedDataMaxLength",
      required: false,
      readonly: true,
      type: "integer"
    } as IntegerConfigurationKey,
    // Sampled measurands to be included in the TransactionData element of StopTransaction.req PDU, every
    // MeterValueSampleInterval seconds from the start of the charging session
    StopTxnSampledData: {
      name: "StopTxnSampledData",
      required: true,
      readonly: false,
      type: "array"
    } as ArrayConfigurationKey,
    // Maximum number of items in a StopTxnSampledData Configuration Key.
    StopTxnSampledDataMaxLength: {
      name: "StopTxnSampledDataMaxLength",
      required: false,
      readonly: true,
      type: "integer"
    } as IntegerConfigurationKey,
    // A list of supported Feature Profiles.
    // Possible profile identifiers: Core, FirmwareManagement, LocalAuthListManagement, Reservation,
    // SmartCharging and RemoteTrigger.
    SupportedFeatureProfiles: {
      name: "SupportedFeatureProfiles",
      required: true,
      readonly: true,
      type: "array"
    } as ArrayConfigurationKey,
    // Maximum number of items in a SupportedFeatureProfiles Configuration Key.
    SupportedFeatureProfilesMaxLength: {
      name: "SupportedFeatureProfilesMaxLength",
      required: false,
      readonly: true,
      type: "integer"
    } as IntegerConfigurationKey,
    // How often (in times) the Charge Point should try to submit a transaction-related message when the Central System fails to process it.
    TransactionMessageAttempts: {
      name: "TransactionMessageAttempts",
      required: true,
      readonly: false,
      type: "integer"
    } as IntegerConfigurationKey,
    // How long (in seconds) the Charge Point should wait before resubmitting a transaction-related message
    // that the Central System failed to process.
    TransactionMessageRetryInterval: {
      name: "TransactionMessageRetryInterval",
      required: true,
      readonly: false,
      type: "integer"
    } as IntegerConfigurationKey,
    // When set to true, the Charge Point SHALL unlock the cable on Charge Point side when the cable is unplugged at the EV.
    UnlockConnectorOnEVSideDisconnect: {
      name: "UnlockConnectorOnEVSideDisconnect",
      required: true,
      readonly: false,
      type: "boolean"
    } as BooleanConfigurationKey,
    // Only relevant for websocket implementations. 0 disables client side websocket Ping/Pong. In this case there is either no
    // ping/pong or the server initiates the ping and client responds with Pong. Positive values are interpreted as number of seconds
    // between pings. Negative values are not allowed. ChangeConfiguration is expected to return a REJECTED result.
    WebSocketPingInterval: {
      name: "WebSocketPingInterval",
      required: false,
      readonly: false,
      type: "integer"
    } as IntegerConfigurationKey
  },
  Reservation: {
    // If this configuration key is present and set to true: Charge Point support reservations on connector 0.
    ReserveConnectorZeroSupported: {
      name: "ReserveConnectorZeroSupported",
      required: false,
      readonly: true,
      type: "boolean"
    } as BooleanConfigurationKey
  },
  LocalAuthListManagement: {
    // whether the Local Authorization List is enabled
    LocalAuthListEnabled: {
      name: "LocalAuthListEnabled",
      required: true,
      readonly: false,
      type: "boolean"
    } as BooleanConfigurationKey,
    // Maximum number of identifications that can be stored in the Local Authorization List
    LocalAuthListMaxLength: {
      name: "LocalAuthListMaxLength",
      required: true,
      readonly: true,
      type: "integer"
    } as IntegerConfigurationKey,
    // Maximum number of identifications that can be send in a single SendLocalList.req
    SendLocalListMaxLength: {
      name: "SendLocalListMaxLength",
      required: true,
      readonly: true,
      type: "integer"
    } as IntegerConfigurationKey
  },
  SmartCharging: {
    // Max StackLevel of a ChargingProfile. The number defined also indicates the max allowed number of installed charging
    // schedules per Charging Profile Purposes.
    ChargeProfileMaxStackLevel: {
      name: "ChargeProfileMaxStackLevel",
      required: true,
      readonly: true,
      type: "integer"
    } as IntegerConfigurationKey,
    // A list of supported quantities for use in a ChargingSchedule. Allowed values: 'Current' and 'Power'
    ChargingScheduleAllowedChargingRateUnit: {
      name: "ChargingScheduleAllowedChargingRateUnit",
      required: true,
      readonly: true,
      type: "array"
    } as ArrayConfigurationKey,
    // Maximum number of periods that may be defined per ChargingSchedule.
    ChargingScheduleMaxPeriods: {
      name: "ChargingScheduleMaxPeriods",
      required: true,
      readonly: true,
      type: "integer"
    } as IntegerConfigurationKey,
    // If defined and true, this Charge Point support switching from 3 to 1 phase during a Transaction.
    ConnectorSwitch3to1PhaseSupported: {
      name: "ConnectorSwitch3to1PhaseSupported",
      required: false,
      readonly: true,
      type: "boolean"
    } as BooleanConfigurationKey,
    // Maximum number of Charging profiles installed at a time
    MaxChargingProfilesInstalled: {
      name: "MaxChargingProfilesInstalled",
      required: true,
      readonly: true,
      type: "integer"
    } as IntegerConfigurationKey
  },
  Custom: {
    OcppServer: {
      name: "OcppServer",
      required: false,
      readonly: false,
      type: "string"
    } as StringConfigurationKey
  },
};

export type ConfigurationKeyType =
  | "integer"
  | "string"
  | "boolean"
  | "array"

export type ConfigurationKey<T = ConfigurationKeyType> = {
  name: string;
  readonly: boolean;
  required: boolean;
  type: T;
}
export type IntegerConfigurationKey = ConfigurationKey<"integer">
export type StringConfigurationKey = ConfigurationKey<"string">
export type BooleanConfigurationKey = ConfigurationKey<"boolean">
export type ArrayConfigurationKey = ConfigurationKey<"array">

export type ConfigurationValueType = number | string | boolean | string[]
export type ConfigurationValue<T = ConfigurationKeyType, V = ConfigurationValueType> = {
  key: ConfigurationKey<T>;
  value: V;
}

export type IntegerConfigurationValue = ConfigurationValue<"integer", number>
export type StringConfigurationValue = ConfigurationValue<"string", string>
export type BooleanConfigurationValue = ConfigurationValue<"boolean", boolean>
export type ArrayConfigurationValue = ConfigurationValue<"array", string[]>

export type Configuration = ConfigurationValue[]

export const defaultConfiguration: (cp: ChargePoint) => Configuration = (cp) => [
  {
    key: ConfigurationKeys.Core.SupportedFeatureProfiles,
    value: [OcppFeatureProfile.Core],
  } as ArrayConfigurationValue,
  {
    key: ConfigurationKeys.Core.NumberOfConnectors,
    value: cp.connectorNumber,
  } as IntegerConfigurationValue,
  {
    key: ConfigurationKeys.Custom.OcppServer,
    value: cp.wsUrl,
  } as StringConfigurationValue,
];
