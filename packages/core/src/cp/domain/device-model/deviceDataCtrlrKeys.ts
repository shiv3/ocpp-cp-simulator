/**
 * The `DeviceDataCtrlr` keys of a 2.x station: the one module that names them
 * (2.0.1 Part 2 Appendices §3.1.7 DeviceDataCtrlr, `ItemsPerMessage` and
 * `BytesPerMessage`, the message in the variable instance).
 *
 * Instance `GetReport` (#605) sizes a station-initiated device-model report.
 * The appendix words it as a constraint on the CSMS's GetReportRequest; the
 * simulator does not enforce it on an inbound GetBaseReport / GetReport. The
 * simulator also honours it as the size of each NotifyReport it sends for a
 * GetBaseReport or GetReport (B07.FR.03, B08.FR.04: "one or more
 * NotifyReportRequest messages"), so one pair of numbers bounds both
 * directions and a CSMS can read the part size it will get.
 *
 * Instances `GetVariables` / `SetVariables` (#606) are the request limits: the
 * most entries, and the most bytes, the station takes in one GetVariables or
 * SetVariables request (B05.FR.11, B06.FR.05). They are constants of the
 * simulated station and read-only.
 */
export const DEVICE_DATA_CTRLR_KEYS = {
  /** `ItemsPerMessage`, instance `GetReport`. */
  itemsPerGetReport: "ItemsPerMessageGetReport",
  /** `BytesPerMessage`, instance `GetReport`. */
  bytesPerGetReport: "BytesPerMessageGetReport",
  itemsPerGetVariables: "ItemsPerMessageGetVariables",
  bytesPerGetVariables: "BytesPerMessageGetVariables",
  itemsPerSetVariables: "ItemsPerMessageSetVariables",
  bytesPerSetVariables: "BytesPerMessageSetVariables",
} as const;

/** ReportData entries in one NotifyReport (the `ItemsPerMessage` default). */
export const REPORT_MAX_ITEMS = 100;

/** Bytes in one NotifyReport frame (the `BytesPerMessage` default). */
export const REPORT_MAX_BYTES = 65536;

/** The most GetVariableData / SetVariableData elements in one request. */
export const VARIABLES_REQUEST_MAX_ITEMS = 100;

/** The largest GetVariables / SetVariables request, in bytes of its JSON. */
export const VARIABLES_REQUEST_MAX_BYTES = 65536;
