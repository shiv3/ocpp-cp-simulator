// The OCPP 2.x Device Model registry (#604): which components and variables
// the station has, and each variable's metadata. Pure data plus lookups; the
// values live in the ConfigurationStore under `valueKey`.
import { MAX_TIMER_MS } from "../../shared/timers";
import {
  DEVICE_DATA_CTRLR_KEYS,
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

/** `MutabilityEnumType`. */
export type DeviceModelMutability = "ReadOnly" | "ReadWrite" | "WriteOnly";

/** The `DataEnumType` values the simulator uses. */
export type DeviceModelDataType =
  "string" | "integer" | "decimal" | "boolean" | "OptionList" | "MemberList";

export type DeviceModelDefault = string | number | boolean | readonly string[];

/**
 * - `Persistent`: a configuration key; a SetVariables value is written to the
 *   state database when one is configured and survives a restart.
 * - `Volatile`: a value the station makes at runtime (or a constant); never
 *   stored, always read-only.
 */
export type DeviceModelPersistence = "Persistent" | "Volatile";

export interface DeviceModelComponentDef {
  readonly name: string;
  /** The component exists once per EVSE: `component.evse` is required. */
  readonly evseScoped?: boolean;
  /** What the component stands for in the simulator. */
  readonly summary: string;
}

export interface DeviceModelVariableDef {
  readonly component: string;
  readonly variable: string;
  /** `variableInstance`, for a variable that exists per instance. */
  readonly instance?: string;
  /**
   * The ConfigurationStore key holding the value. For an EVSE-scoped
   * variable, the prefix of the per-EVSE key (`evseValueKey`).
   */
  readonly valueKey: string;
  /** `valueKey` is also an OCPP 1.6 configuration key (same store entry). */
  readonly sharedWith16: boolean;
  readonly mutability: DeviceModelMutability;
  readonly dataType: DeviceModelDataType;
  /**
   * The accepted values of an `OptionList` / `MemberList`; for a ReadOnly
   * variable, the values it supports (VariableCharacteristicsType.valuesList
   * is mandatory for OptionList, MemberList and SequenceList).
   */
  readonly valuesList?: readonly string[];
  /** Inclusive bounds of an `integer` / `decimal` variable. */
  readonly min?: number;
  readonly max?: number;
  readonly unit?: string;
  /** The value of a fresh station; also the value a constant publishes. */
  readonly default?: DeviceModelDefault;
  readonly persistence: DeviceModelPersistence;
  /**
   * Required when the variable is writable: the simulated behavior that
   * follows from changing it. A variable with no such behavior is ReadOnly or
   * not registered (#569: configuration acceptance implies implemented
   * behavior).
   */
  readonly effect?: string;
  /**
   * A fixed value the station publishes at start-up (`default`) because
   * nothing else defines it. Volatile and ReadOnly.
   */
  readonly constant?: boolean;
}

export type DeviceModelLookup =
  | { readonly status: "UnknownComponent" }
  | { readonly status: "UnknownVariable" }
  | { readonly status: "Found"; readonly variable: DeviceModelVariableDef };

export interface DeviceModelRegistry {
  readonly components: readonly DeviceModelComponentDef[];
  readonly variables: readonly DeviceModelVariableDef[];
  /** Whether the station has a component of this name. */
  hasComponent(name: string): boolean;
  isEvseScoped(component: string): boolean;
  /**
   * The variable `component.variable[instance]`. An exact instanced entry
   * wins; otherwise the instance-less entry answers whatever instance the
   * CSMS names, so an instanced variable is only found with its instance.
   */
  find(
    component: string,
    variable: string,
    instance?: string,
  ): DeviceModelVariableDef | undefined;
  /** The variable behind a store key (the prefix, for an EVSE-scoped one). */
  byValueKey(valueKey: string): DeviceModelVariableDef | undefined;
  variablesOf(component: string): readonly DeviceModelVariableDef[];
}

/** `component/variable[/instance]`, the registry's identity of a variable. */
export function deviceModelVariableId(v: {
  component: string;
  variable: string;
  instance?: string;
}): string {
  return v.instance === undefined
    ? `${v.component}/${v.variable}`
    : `${v.component}/${v.variable}/${v.instance}`;
}

/**
 * Build a registry, refusing an inconsistent definition (duplicate id,
 * unknown component, a writable variable without `effect`, bounds on a
 * non-numeric type, a default outside its limits, a Volatile variable that
 * is writable). Throws `Error` naming the entry.
 */
export function createDeviceModelRegistry(
  components: readonly DeviceModelComponentDef[],
  variables: readonly DeviceModelVariableDef[],
): DeviceModelRegistry {
  const componentByName = new Map<string, DeviceModelComponentDef>();
  for (const c of components) {
    if (componentByName.has(c.name)) {
      throw new Error(`device model: duplicate component ${c.name}`);
    }
    componentByName.set(c.name, c);
  }
  const byId = new Map<string, DeviceModelVariableDef>();
  const byKey = new Map<string, DeviceModelVariableDef>();
  const perComponent = new Map<string, DeviceModelVariableDef[]>();
  for (const v of variables) {
    const id = deviceModelVariableId(v);
    const fail = (why: string): never => {
      throw new Error(`device model: ${id}: ${why}`);
    };
    if (byId.has(id)) fail("duplicate variable");
    if (!componentByName.has(v.component)) fail("unknown component");
    if (v.mutability !== "ReadOnly" && v.effect === undefined) {
      fail("a writable variable needs its effect");
    }
    if (v.persistence === "Volatile" && v.mutability !== "ReadOnly") {
      fail("a volatile variable is read-only");
    }
    if (v.constant === true && v.default === undefined) {
      fail("a constant needs a default");
    }
    if (v.constant === true && v.persistence !== "Volatile") {
      fail("a constant is volatile");
    }
    const numeric = v.dataType === "integer" || v.dataType === "decimal";
    if (!numeric && (v.min !== undefined || v.max !== undefined)) {
      fail("min/max on a non-numeric variable");
    }
    if (v.min !== undefined && v.max !== undefined && v.min > v.max) {
      fail("min above max");
    }
    const listed = v.dataType === "OptionList" || v.dataType === "MemberList";
    if (listed !== (v.valuesList !== undefined)) {
      fail(
        "valuesList goes with OptionList and MemberList, and only with them",
      );
    }
    if (typeof v.default === "number") {
      if (v.min !== undefined && v.default < v.min) fail("default below min");
      if (v.max !== undefined && v.default > v.max) fail("default above max");
    }
    if (v.valuesList !== undefined && v.default !== undefined) {
      const members =
        typeof v.default === "string"
          ? v.dataType === "MemberList"
            ? v.default.split(",")
            : [v.default]
          : Array.isArray(v.default)
            ? v.default
            : [];
      if (members.some((m) => !v.valuesList?.includes(m))) {
        fail("default outside valuesList");
      }
    }
    const ownerKey = componentByName.get(v.component)?.evseScoped
      ? `evse:${v.valueKey}`
      : v.valueKey;
    if (byKey.has(ownerKey)) fail(`valueKey ${v.valueKey} already registered`);
    byId.set(id, v);
    byKey.set(ownerKey, v);
    const list = perComponent.get(v.component) ?? [];
    list.push(v);
    perComponent.set(v.component, list);
  }
  return {
    components,
    variables,
    hasComponent: (name) => componentByName.has(name),
    isEvseScoped: (name) => componentByName.get(name)?.evseScoped === true,
    find: (component, variable, instance) =>
      (instance !== undefined
        ? byId.get(`${component}/${variable}/${instance}`)
        : undefined) ?? byId.get(`${component}/${variable}`),
    byValueKey: (valueKey) =>
      byKey.get(valueKey) ?? byKey.get(`evse:${valueKey}`),
    variablesOf: (component) => perComponent.get(component) ?? [],
  };
}

const COMPONENTS: readonly DeviceModelComponentDef[] = [
  { name: "OCPPCommCtrlr", summary: "OCPP communication settings." },
  { name: "TxCtrlr", summary: "Transaction behavior." },
  { name: "SampledDataCtrlr", summary: "Sampled meter values." },
  { name: "AlignedDataCtrlr", summary: "Clock-aligned meter values." },
  { name: "LocalAuthListCtrlr", summary: "The local authorization list." },
  { name: "AuthCtrlr", summary: "Authorization." },
  { name: "AuthCacheCtrlr", summary: "The authorization cache." },
  { name: "ReservationCtrlr", summary: "Reservations." },
  { name: "MonitoringCtrlr", summary: "Variable monitoring." },
  { name: "ChargingStation", summary: "The station as a whole." },
  { name: "SecurityCtrlr", summary: "Security and certificates." },
  {
    name: "EVSE",
    evseScoped: true,
    summary: "One EVSE (EVSE N is connector N).",
  },
  {
    name: "Connector",
    evseScoped: true,
    summary: "The one connector of an EVSE.",
  },
  { name: "DeviceDataCtrlr", summary: "Device model reporting." },
  // Components the station has but that publish no variable yet: a request
  // for one of their variables is UnknownVariable, not UnknownComponent.
  // Variables are added with the behavior that backs them (#605, #607, #612).
  { name: "ClockCtrlr", summary: "Station clock." },
  { name: "TariffCostCtrlr", summary: "Tariff and cost." },
  { name: "ISO15118Ctrlr", summary: "ISO 15118 communication." },
];

/** A `Persistent` ConfigurationStore key shared with OCPP 1.6 unless noted. */
const persistent = (
  component: string,
  variable: string,
  valueKey: string,
  rest: Omit<
    DeviceModelVariableDef,
    "component" | "variable" | "valueKey" | "persistence" | "sharedWith16"
  > & { sharedWith16?: boolean },
): DeviceModelVariableDef => ({
  component,
  variable,
  valueKey,
  persistence: "Persistent",
  sharedWith16: true,
  ...rest,
});

/** A value the station makes at runtime: Volatile, ReadOnly, 2.x only. */
const runtime = (
  component: string,
  variable: string,
  valueKey: string,
  rest: Omit<
    DeviceModelVariableDef,
    | "component"
    | "variable"
    | "valueKey"
    | "persistence"
    | "sharedWith16"
    | "mutability"
  >,
): DeviceModelVariableDef => ({
  component,
  variable,
  valueKey,
  persistence: "Volatile",
  sharedWith16: false,
  mutability: "ReadOnly",
  ...rest,
});

/**
 * The measurands the meter value builder models (`MeterValueBuilder`) that are
 * in the 2.x `MeasurandEnumType` (no `Temperature` or `RPM`, 1.6 measurands;
 * #714).
 */
const METER_MEASURANDS: readonly string[] = [
  "Energy.Active.Import.Register",
  "Energy.Active.Import.Interval",
  "Energy.Active.Export.Register",
  "Energy.Active.Export.Interval",
  "Energy.Reactive.Import.Register",
  "Energy.Reactive.Import.Interval",
  "Energy.Reactive.Export.Register",
  "Energy.Reactive.Export.Interval",
  "Voltage",
  "Current.Import",
  "Current.Export",
  "Current.Offered",
  "Power.Active.Import",
  "Power.Active.Export",
  "Power.Reactive.Import",
  "Power.Reactive.Export",
  "Power.Offered",
  "Power.Factor",
  "SoC",
  "Frequency",
];

const VARIABLES: readonly DeviceModelVariableDef[] = [
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
  // ReadOnly on 2.x although 1.6 lists the key read-write (§9.1): the
  // simulated reset never fails, so nothing retries and a writable value
  // would change nothing (#569). `defaultConfiguration` marks the 2.x store
  // key read-only to match.
  persistent("OCPPCommCtrlr", "ResetRetries", "ResetRetries", {
    mutability: "ReadOnly",
    dataType: "integer",
    default: 1,
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
  persistent("AuthCtrlr", "AuthorizeRemoteStart", "AuthorizeRemoteTxRequests", {
    mutability: "ReadOnly",
    dataType: "boolean",
    default: false,
  }),
  // #452: local authorization (2.0.1 Part 2 §2.3-§2.4, C10-C15).
  persistent("AuthCtrlr", "LocalPreAuthorize", "LocalPreAuthorize", {
    mutability: "ReadWrite",
    dataType: "boolean",
    default: false,
    effect: "An id is started on a local decision before the CSMS answers.",
  }),
  persistent("AuthCtrlr", "LocalAuthorizeOffline", "LocalAuthorizeOffline", {
    mutability: "ReadWrite",
    dataType: "boolean",
    default: true,
    effect: "An offline station authorizes from the local list and cache.",
  }),
  persistent(
    "AuthCtrlr",
    "OfflineTxForUnknownIdEnabled",
    "AllowOfflineTxForUnknownId",
    {
      mutability: "ReadWrite",
      dataType: "boolean",
      default: false,
      effect: "An offline station starts a transaction for an unknown id.",
    },
  ),
  // #598: C12.FR.09; "" = no master pass. 2.x only.
  persistent("AuthCtrlr", "MasterPassGroupId", "MasterPassGroupId", {
    sharedWith16: false,
    mutability: "ReadWrite",
    dataType: "string",
    default: "",
    effect:
      "A RequestStartTransaction whose groupIdToken is this group is refused.",
  }),
  persistent("AuthCacheCtrlr", "Enabled", "AuthorizationCacheEnabled", {
    mutability: "ReadWrite",
    dataType: "boolean",
    default: false,
    effect: "The authorization cache is used or not.",
  }),
  persistent("AuthCacheCtrlr", "LifeTime", "AuthCacheLifeTime", {
    sharedWith16: false,
    mutability: "ReadWrite",
    dataType: "integer",
    min: 0,
    default: 0,
    effect: "Seconds a cached authorization stays valid.",
  }),
  persistent("TxCtrlr", "StopTxOnInvalidId", "StopTransactionOnInvalidId", {
    mutability: "ReadWrite",
    dataType: "boolean",
    default: true,
    effect: "A transaction stops when its id is invalidated.",
  }),
  persistent("TxCtrlr", "MaxEnergyOnInvalidId", "MaxEnergyOnInvalidId", {
    mutability: "ReadWrite",
    dataType: "integer",
    unit: "Wh",
    default: 0,
    effect: "Wh still delivered after the id of a transaction is invalidated.",
  }),
  // #709: H01.FR.18/19, the 2.x name of 1.6 ReserveConnectorZeroSupported.
  persistent(
    "ReservationCtrlr",
    "NonEvseSpecific",
    "ReserveConnectorZeroSupported",
    {
      mutability: "ReadOnly",
      dataType: "boolean",
      default: false,
    },
  ),
  persistent(
    "TxCtrlr",
    "StopTxOnEVSideDisconnect",
    "StopTransactionOnEVSideDisconnect",
    {
      mutability: "ReadWrite",
      dataType: "boolean",
      default: true,
      effect: "A transaction stops when the EV unplugs.",
    },
  ),
  // #604: when a transaction starts and stops is fixed in the simulator
  // (Started on authorization, Ended on deauthorization, EV disconnect or
  // connection timeout). These two describe it and are ReadOnly until the
  // transaction timing follows them (a follow-up of #604): writable now, they
  // would accept a value that changes nothing (#569).
  runtime("TxCtrlr", "TxStartPoint", "TxStartPoint", {
    dataType: "MemberList",
    valuesList: ["Authorized"],
    default: "Authorized",
    constant: true,
  }),
  runtime("TxCtrlr", "TxStopPoint", "TxStopPoint", {
    dataType: "MemberList",
    valuesList: ["Authorized", "EVConnected"],
    default: "Authorized,EVConnected",
    constant: true,
  }),
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
      effect: "Monitoring events up to this severity are queued while offline.",
    },
  ),
  runtime(
    "ChargingStation",
    "AvailabilityState",
    RUNTIME_VALUE_KEYS.chargingStationAvailabilityState,
    { dataType: "OptionList", valuesList: V2_CONNECTOR_STATUSES },
  ),
  // #537: 2.0.1 / 2.1 Part 2 referenced components §2.2.4, §2.2.7-§2.2.9.
  persistent("SecurityCtrlr", "CertificateEntries", "CertificateEntries", {
    sharedWith16: false,
    mutability: "ReadOnly",
    dataType: "integer",
    min: 0,
    default: 0,
  }),
  persistent(
    "SecurityCtrlr",
    "MaxCertificateChainSize",
    "MaxCertificateChainSize",
    {
      sharedWith16: false,
      mutability: "ReadOnly",
      dataType: "integer",
      min: 1,
      max: 10000,
      default: 10000,
    },
  ),
  persistent(
    "SecurityCtrlr",
    "CertSigningWaitMinimum",
    "CertSigningWaitMinimum",
    {
      sharedWith16: false,
      mutability: "ReadWrite",
      dataType: "integer",
      min: 1,
      default: 60,
      effect: "Seconds to wait for CertificateSigned before resending.",
    },
  ),
  persistent(
    "SecurityCtrlr",
    "CertSigningRepeatTimes",
    "CertSigningRepeatTimes",
    {
      sharedWith16: false,
      mutability: "ReadWrite",
      dataType: "integer",
      min: 0,
      default: 3,
      effect: "How many times SignCertificate is resent.",
    },
  ),
  // #538: per-EVSE runtime values; `valueKey` is the prefix of the per-EVSE
  // key. EVSE N is connector N and has one connector, number 1.
  runtime("EVSE", "Power", RUNTIME_VALUE_KEYS.evsePower, {
    dataType: "decimal",
    unit: "W",
  }),
  runtime("EVSE", "AvailabilityState", RUNTIME_VALUE_KEYS.evseState, {
    dataType: "OptionList",
    valuesList: V2_CONNECTOR_STATUSES,
  }),
  runtime("Connector", "AvailabilityState", RUNTIME_VALUE_KEYS.connectorState, {
    dataType: "OptionList",
    valuesList: V2_CONNECTOR_STATUSES,
  }),
];

/** The Device Model of the simulator's OCPP 2.x stations. */
export const DEVICE_MODEL: DeviceModelRegistry = createDeviceModelRegistry(
  COMPONENTS,
  VARIABLES,
);
