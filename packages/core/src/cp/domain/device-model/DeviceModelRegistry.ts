// The OCPP 2.x Device Model registry (#604): which components and variables
// the station has, and each variable's metadata. Pure data plus lookups; the
// values live in the ConfigurationStore under `valueKey`.
import { COMM_AND_METERING_VARIABLES } from "./variablesCommAndMetering";
import { AUTH_AND_TRANSACTION_VARIABLES } from "./variablesAuthAndTransaction";
import { REQUIRED_AND_MONITORING_VARIABLES } from "./variablesRequiredAndMonitoring";
import { SECURITY_AND_EVSE_VARIABLES } from "./variablesSecurityAndEvse";

/** `MutabilityEnumType`. */
export type DeviceModelMutability = "ReadOnly" | "ReadWrite" | "WriteOnly";

/** The `DataEnumType` values the simulator uses. */
export type DeviceModelDataType =
  | "string"
  | "dateTime"
  | "integer"
  | "decimal"
  | "boolean"
  | "OptionList"
  | "MemberList";

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
  /**
   * A MemberList only: the member sets the simulator implements, when not
   * every subset of `valuesList` is (#697). A write of any other set is
   * Rejected (#569: configuration acceptance implies implemented behavior).
   */
  readonly allowedLists?: readonly (readonly string[])[];
  /** Inclusive bounds of an `integer` / `decimal` variable. */
  readonly min?: number;
  readonly max?: number;
  readonly unit?: string;
  /**
   * `maxLimit` of a non-numeric variable: for a `string`, its maximum length
   * (VariableCharacteristicsType). Reported only; `max` stays for numbers.
   */
  readonly maxLimit?: number;
  /**
   * `false` when no monitor may be installed on the variable (reported as
   * `supportsMonitoring: false`; SetVariableMonitoring answers
   * `UnsupportedMonitorType`). Defaults to true.
   */
  readonly supportsMonitoring?: boolean;
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

/**
 * The mutability this station reports and enforces for `def`. The registry is
 * static; a station can make a ReadWrite key read-only through its store entry
 * (`AuthorizeRemoteTxRequestsReadOnly`, #922). A ReadOnly or WriteOnly
 * definition is never widened.
 */
export function effectiveMutability(
  def: DeviceModelVariableDef,
  key: { readonly readonly: boolean },
): DeviceModelMutability {
  return def.mutability === "ReadWrite" && key.readonly
    ? "ReadOnly"
    : def.mutability;
}

/** Whether two member lists hold the same members, in any order. */
export function sameMembers(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
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
    if (v.allowedLists !== undefined) {
      if (v.dataType !== "MemberList") fail("allowedLists on a non-MemberList");
      for (const list of v.allowedLists) {
        if (list.some((m) => !v.valuesList?.includes(m))) {
          fail("allowedLists outside valuesList");
        }
      }
      const def = Array.isArray(v.default)
        ? v.default
        : typeof v.default === "string"
          ? v.default.split(",")
          : [];
      if (!v.allowedLists.some((l) => sameMembers(l, def))) {
        fail("default outside allowedLists");
      }
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
    summary: "One EVSE of the station topology (one connector each today).",
  },
  {
    name: "Connector",
    evseScoped: true,
    summary: "A connector of an EVSE (connector 1 today).",
  },
  { name: "DeviceDataCtrlr", summary: "Device model reporting." },
  // Components the station has but that publish no variable yet: a request
  // for one of their variables is UnknownVariable, not UnknownComponent.
  // Variables are added with the behavior that backs them (#605, #607, #612).
  { name: "ClockCtrlr", summary: "Station clock." },
  { name: "TariffCostCtrlr", summary: "Tariff and cost." },
  { name: "ISO15118Ctrlr", summary: "ISO 15118 communication." },
];

const VARIABLES: readonly DeviceModelVariableDef[] = [
  ...COMM_AND_METERING_VARIABLES,
  ...AUTH_AND_TRANSACTION_VARIABLES,
  ...REQUIRED_AND_MONITORING_VARIABLES,
  ...SECURITY_AND_EVSE_VARIABLES,
];

/** The Device Model of the simulator's OCPP 2.x stations. */
export const DEVICE_MODEL: DeviceModelRegistry = createDeviceModelRegistry(
  COMPONENTS,
  VARIABLES,
);
