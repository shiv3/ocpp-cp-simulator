/**
 * The `DeviceDataCtrlr` keys of a 2.x station: the one module that names them
 * (the GetVariables / SetVariables request limits of #606 belong here too).
 *
 * The DeviceDataCtrlr limits that size a station-initiated device-model report
 * (#605): `ItemsPerMessage` and `BytesPerMessage` with instance `GetReport`
 * (2.0.1 Part 2 Appendices §3.1.7 DeviceDataCtrlr).
 *
 * The appendix words them as constraints on the CSMS's GetReportRequest; the
 * simulator does not enforce them on an inbound GetBaseReport / GetReport. The
 * simulator also honours them as the size of each NotifyReport it sends for a
 * GetBaseReport or GetReport (B07.FR.03, B08.FR.04: "one or more
 * NotifyReportRequest messages"), so one pair of numbers bounds both
 * directions and a CSMS can read the part size it will get.
 */
export const DEVICE_DATA_CTRLR_KEYS = {
  /** `ItemsPerMessage`, instance `GetReport`. */
  itemsPerGetReport: "ItemsPerMessageGetReport",
  /** `BytesPerMessage`, instance `GetReport`. */
  bytesPerGetReport: "BytesPerMessageGetReport",
} as const;

/** ReportData entries in one NotifyReport (the `ItemsPerMessage` default). */
export const REPORT_MAX_ITEMS = 100;

/** Bytes in one NotifyReport frame (the `BytesPerMessage` default). */
export const REPORT_MAX_BYTES = 65536;
