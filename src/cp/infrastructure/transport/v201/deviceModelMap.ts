// Explicit OCPP 1.6 config key <-> OCPP 2.0.1 (Component, Variable[, instance]) mapping. Phase 1b seam.
// Keyed by `${component}/${variable}` or, for an instanced variable,
// `${component}/${variable}/${instance}` -> 1.6 ConfigurationStore key name.
// Start with the cleanly-mapped keys.
import {
  evseValueKey,
  RUNTIME_VALUE_KEYS,
} from "../../../domain/charge-point/runtimeValueKeys";

export const V201_VARIABLE_TO_V16_KEY: ReadonlyMap<string, string> = new Map([
  ["OCPPCommCtrlr/HeartbeatInterval", "HeartbeatInterval"],
  ["OCPPCommCtrlr/WebSocketPingInterval", "WebSocketPingInterval"],
  ["OCPPCommCtrlr/ResetRetries", "ResetRetries"],
  // #490: OCPP 2.0.1 §2.1.10/2.1.11, 2.1 §2.1.12 — variableInstance
  // "TransactionEvent" ("MessageAttemptsTransactionEvent" is only the
  // section title).
  [
    "OCPPCommCtrlr/MessageAttempts/TransactionEvent",
    "TransactionMessageAttempts",
  ],
  [
    "OCPPCommCtrlr/MessageAttemptInterval/TransactionEvent",
    "TransactionMessageRetryInterval",
  ],
  // #529: OCPP 2.0.1 / 2.1 Part 2 §2.1.3 "DefaultMessageTimeout" —
  // variableInstance "Default", ReadOnly, seconds.
  ["OCPPCommCtrlr/MessageTimeout/Default", "MessageTimeout"],
  ["TxCtrlr/EVConnectionTimeOut", "ConnectionTimeOut"],
  ["SampledDataCtrlr/TxUpdatedInterval", "MeterValueSampleInterval"],
  ["SampledDataCtrlr/TxUpdatedMeasurands", "MeterValuesSampledData"],
  ["SampledDataCtrlr/SignReadings", "SampledDataSignReadings"],
  ["AlignedDataCtrlr/Interval", "ClockAlignedDataInterval"],
  ["AlignedDataCtrlr/Measurands", "MeterValuesAlignedData"],
  ["LocalAuthListCtrlr/Enabled", "LocalAuthListEnabled"],
  ["LocalAuthListCtrlr/ItemsPerMessage", "SendLocalListMaxLength"],
  ["AuthCtrlr/AuthorizeRemoteStart", "AuthorizeRemoteTxRequests"],
  // #452: local authorization (2.0.1 Part 2 §2.3-§2.4, C10-C15).
  ["AuthCtrlr/LocalPreAuthorize", "LocalPreAuthorize"],
  ["AuthCtrlr/LocalAuthorizeOffline", "LocalAuthorizeOffline"],
  ["AuthCtrlr/OfflineTxForUnknownIdEnabled", "AllowOfflineTxForUnknownId"],
  ["AuthCacheCtrlr/Enabled", "AuthorizationCacheEnabled"],
  ["AuthCacheCtrlr/LifeTime", "AuthCacheLifeTime"],
  ["TxCtrlr/StopTxOnInvalidId", "StopTransactionOnInvalidId"],
  ["TxCtrlr/StopTxOnEVSideDisconnect", "StopTransactionOnEVSideDisconnect"],
  // #538: MonitoringCtrlr (2.0.1 Part 2 §2.11.3-§2.11.9, 2.1 §2.13.3-
  // §2.13.9), read-only values the station defines at runtime (2.x only).
  // ItemsPerMessage / BytesPerMessage exist per variableInstance.
  ...["SetVariableMonitoring", "ClearVariableMonitoring"].flatMap(
    (instance): [string, string][] => [
      [
        `MonitoringCtrlr/ItemsPerMessage/${instance}`,
        `ItemsPerMessage${instance}`,
      ],
      [
        `MonitoringCtrlr/BytesPerMessage/${instance}`,
        `BytesPerMessage${instance}`,
      ],
    ],
  ),
  ["MonitoringCtrlr/ActiveMonitoringLevel", "ActiveMonitoringLevel"],
  ["MonitoringCtrlr/ActiveMonitoringBase", "ActiveMonitoringBase"],
  // #538: runtime value (2.x only), the station-level status, from the
  // standardized components of the Part 2 appendices (required there).
  [
    "ChargingStation/AvailabilityState",
    RUNTIME_VALUE_KEYS.chargingStationAvailabilityState,
  ],
]);

/**
 * #538: device-model variables with one value per EVSE, all runtime values
 * the 2.x station publishes (the standardized EVSE / Connector variables of
 * the Part 2 appendices). Keyed `${component}/${variable}`; the
 * configuration key of EVSE N is {@link evseValueKey}. EVSE N is connector
 * N and has one connector, number 1.
 */
export const V201_EVSE_VARIABLES: ReadonlyMap<
  string,
  { readonly keyPrefix: string; readonly unit?: string }
> = new Map([
  ["EVSE/Power", { keyPrefix: RUNTIME_VALUE_KEYS.evsePower, unit: "W" }],
  ["EVSE/AvailabilityState", { keyPrefix: RUNTIME_VALUE_KEYS.evseState }],
  [
    "Connector/AvailabilityState",
    { keyPrefix: RUNTIME_VALUE_KEYS.connectorState },
  ],
]);

/** Components whose variables exist per EVSE (and need `component.evse`). */
export const EVSE_SCOPED_V201_COMPONENTS: ReadonlySet<string> = new Set(
  [...V201_EVSE_VARIABLES.keys()].map((k) => k.split("/")[0]),
);

export interface DeviceModelEvse {
  readonly id: number;
  readonly connectorId?: number;
}

export type DeviceModelResolution =
  | { readonly status: "UnknownComponent" }
  | { readonly status: "UnknownVariable" }
  | { readonly status: "Found"; readonly valueKey: string };

/**
 * The configuration key behind `component.variable[instance]`, EVSE scope
 * included (#538). An EVSE-scoped component (EVSE, Connector) is only found
 * with an `evse` the station has (B06.FR.06, N04.FR.03); without
 * `evseExists` the station has none. A station-wide component ignores
 * `component.evse` here, as GetVariables / SetVariables always did.
 */
export function resolveDeviceModelVariable(
  component: { readonly name: string; readonly evse?: DeviceModelEvse },
  variable: { readonly name: string; readonly instance?: string },
  evseExists: (evse: DeviceModelEvse) => boolean = () => false,
): DeviceModelResolution {
  if (EVSE_SCOPED_V201_COMPONENTS.has(component.name)) {
    if (component.evse === undefined || !evseExists(component.evse)) {
      return { status: "UnknownComponent" };
    }
    const entry = V201_EVSE_VARIABLES.get(`${component.name}/${variable.name}`);
    return entry === undefined
      ? { status: "UnknownVariable" }
      : {
          status: "Found",
          valueKey: evseValueKey(entry.keyPrefix, component.evse.id),
        };
  }
  if (!KNOWN_V201_COMPONENTS.has(component.name)) {
    return { status: "UnknownComponent" };
  }
  const valueKey = lookupV16Key(
    component.name,
    variable.name,
    variable.instance,
  );
  return valueKey === undefined
    ? { status: "UnknownVariable" }
    : { status: "Found", valueKey };
}

// Components that appear in the table - used to distinguish UnknownComponent vs UnknownVariable.
export const KNOWN_V201_COMPONENTS: ReadonlySet<string> = new Set(
  [...V201_VARIABLE_TO_V16_KEY.keys()].map((k) => k.split("/")[0]),
);

/** A map key split back into the device-model names it stands for. */
export function parseV201VariableKey(key: string): {
  component: string;
  variable: string;
  instance?: string;
} {
  const [component, variable, instance] = key.split("/");
  return {
    component,
    variable,
    ...(instance !== undefined ? { instance } : {}),
  };
}

/**
 * The 1.6 key behind `component.variable[instance]`. An exact instanced
 * entry wins; otherwise the instance-less entry answers whatever instance
 * the CSMS names (as before instances were modelled), so an instanced
 * variable is only found with its instance.
 */
export function lookupV16Key(
  component: string,
  variable: string,
  instance?: string,
): string | undefined {
  if (instance !== undefined) {
    const exact = V201_VARIABLE_TO_V16_KEY.get(
      `${component}/${variable}/${instance}`,
    );
    if (exact !== undefined) return exact;
  }
  return V201_VARIABLE_TO_V16_KEY.get(`${component}/${variable}`);
}
