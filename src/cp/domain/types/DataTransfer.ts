/**
 * The CSMS's answer to a station-initiated DataTransfer.req (#348).
 *
 * The four statuses are spelled identically in OCPP 1.6 §7.19 and 2.0.1
 * `DataTransferStatusEnumType`. `data` is a string on 1.6 and any JSON on
 * 2.0.1, so it is `unknown` here; the version-specific handler leaves it as
 * the wire carried it.
 */
export const DATA_TRANSFER_STATUSES = [
  "Accepted",
  "Rejected",
  "UnknownMessageId",
  "UnknownVendorId",
] as const;
export type DataTransferStatus = (typeof DATA_TRANSFER_STATUSES)[number];

export interface DataTransferResult {
  readonly status: DataTransferStatus;
  readonly data?: unknown;
}

/** How long a control-plane `data_transfer` waits for the CSMS's answer
 *  before its promise rejects. The CALL itself is not withdrawn: a late
 *  CALLRESULT is still logged by the ordinary result handler. */
export const DATA_TRANSFER_RESPONSE_TIMEOUT_MS = 30_000;
