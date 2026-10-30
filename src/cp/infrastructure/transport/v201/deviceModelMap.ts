// Explicit OCPP 1.6 config key <-> OCPP 2.0.1 (Component, Variable[, instance]) mapping. Phase 1b seam.
// Keyed by `${component}/${variable}` or, for an instanced variable,
// `${component}/${variable}/${instance}` -> 1.6 ConfigurationStore key name.
// Start with the cleanly-mapped keys.
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
]);

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
