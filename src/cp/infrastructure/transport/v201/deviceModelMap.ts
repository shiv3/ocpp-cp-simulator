// Explicit OCPP 1.6 config key <-> OCPP 2.0.1 (Component, Variable) mapping. Phase 1b seam.
// Keyed by `${component}/${variable}` -> 1.6 ConfigurationStore key name. Start with the cleanly-mapped keys.
export const V201_VARIABLE_TO_V16_KEY: ReadonlyMap<string, string> = new Map([
  ["OCPPCommCtrlr/HeartbeatInterval", "HeartbeatInterval"],
  ["OCPPCommCtrlr/WebSocketPingInterval", "WebSocketPingInterval"],
  ["OCPPCommCtrlr/ResetRetries", "ResetRetries"],
  ["TxCtrlr/EVConnectionTimeOut", "ConnectionTimeOut"],
  ["SampledDataCtrlr/TxUpdatedInterval", "MeterValueSampleInterval"],
  ["SampledDataCtrlr/TxUpdatedMeasurands", "MeterValuesSampledData"],
  ["AlignedDataCtrlr/Interval", "ClockAlignedDataInterval"],
  ["LocalAuthListCtrlr/Enabled", "LocalAuthListEnabled"],
  ["LocalAuthListCtrlr/ItemsPerMessage", "SendLocalListMaxLength"],
  ["AuthCtrlr/AuthorizeRemoteStart", "AuthorizeRemoteTxRequests"],
  ["TxCtrlr/StopTxOnInvalidId", "StopTransactionOnInvalidId"],
  ["TxCtrlr/StopTxOnEVSideDisconnect", "StopTransactionOnEVSideDisconnect"],
]);

// Components that appear in the table - used to distinguish UnknownComponent vs UnknownVariable.
export const KNOWN_V201_COMPONENTS: ReadonlySet<string> = new Set(
  [...V201_VARIABLE_TO_V16_KEY.keys()].map((k) => k.split("/")[0]),
);

export function lookupV16Key(
  component: string,
  variable: string,
): string | undefined {
  return V201_VARIABLE_TO_V16_KEY.get(`${component}/${variable}`);
}
