/**
 * The `DeviceDataCtrlr` request limits of a 2.x station (#606): the most
 * entries, and the most bytes, it takes in one GetVariables or SetVariables
 * request (2.0.1 Part 2 Appendices §3.1.7 `ItemsPerMessage` and
 * `BytesPerMessage`, the message in the variable instance; B05.FR.11,
 * B06.FR.05). They are constants of the simulated station and read-only.
 */
export const DEVICE_DATA_CTRLR_KEYS = {
  itemsPerGetVariables: "ItemsPerMessageGetVariables",
  bytesPerGetVariables: "BytesPerMessageGetVariables",
  itemsPerSetVariables: "ItemsPerMessageSetVariables",
  bytesPerSetVariables: "BytesPerMessageSetVariables",
} as const;

/** The most GetVariableData / SetVariableData elements in one request. */
export const VARIABLES_REQUEST_MAX_ITEMS = 100;

/** The largest GetVariables / SetVariables request, in bytes of its JSON. */
export const VARIABLES_REQUEST_MAX_BYTES = 65536;
