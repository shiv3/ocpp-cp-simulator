/**
 * Station-initiated firmware / log status vocabularies (#345).
 *
 * `FIRMWARE_STATUSES` is OCPP 2.0.1 `FirmwareStatusEnumType`, which is also
 * the 1.6 Security Whitepaper `SignedFirmwareStatusNotification` set; plain
 * 1.6 `FirmwareStatusNotification` speaks the first seven only.
 * `UPLOAD_LOG_STATUSES` is 2.0.1 `UploadLogStatusEnumType`; the 1.6
 * Whitepaper `LogStatusNotification` set is the same minus `AcceptedCanceled`.
 */
export const FIRMWARE_STATUSES = [
  "Downloaded",
  "DownloadFailed",
  "Downloading",
  "Idle",
  "InstallationFailed",
  "Installing",
  "Installed",
  "DownloadScheduled",
  "DownloadPaused",
  "InstallRebooting",
  "InstallScheduled",
  "InstallVerificationFailed",
  "InvalidSignature",
  "SignatureVerified",
] as const;
export type FirmwareStatus = (typeof FIRMWARE_STATUSES)[number];

/** The seven statuses plain OCPP 1.6 FirmwareStatusNotification.req spells. */
export const FIRMWARE_STATUSES_V16 = FIRMWARE_STATUSES.slice(0, 7);
export type FirmwareStatusV16 = (typeof FIRMWARE_STATUSES)[
  0 | 1 | 2 | 3 | 4 | 5 | 6];

export const UPLOAD_LOG_STATUSES = [
  "BadMessage",
  "Idle",
  "NotSupportedOperation",
  "PermissionDenied",
  "Uploaded",
  "UploadFailure",
  "Uploading",
  "AcceptedCanceled",
] as const;
export type UploadLogStatus = (typeof UPLOAD_LOG_STATUSES)[number];
