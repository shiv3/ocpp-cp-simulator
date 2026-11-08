/**
 * OCPP 1.6 security whitepaper edition 4, chapter "Security Events": the
 * types whose "Critical" column is Yes. A04.FR.01/02: the Charge Point
 * informs the Central System of a critical security event, and the
 * notification MUST be queued while the Charge Point is disconnected.
 * Every other type, vendor-specific ones included, is dropped while offline
 * (`InvalidFirmwareSignature` is not critical in this table, unlike 2.x).
 */
export const CRITICAL_SECURITY_EVENT_TYPES_16: ReadonlySet<string> = new Set([
  "FirmwareUpdated",
  "SettingSystemTime",
  "StartupOfTheDevice",
  "ResetOrReboot",
  "SecurityLogWasCleared",
  "MemoryExhaustion",
  "TamperDetectionActivated",
  "InvalidFirmwareSigningCertificate",
  "InvalidCentralSystemCertificate",
  "InvalidChargePointCertificate",
  "InvalidTLSVersion",
  "InvalidTLSCipherSuite",
  "MaintenanceLoginAccepted",
  "MaintenanceLoginFailed",
  "DiscardedRenewedClientCertificate",
]);

export function isCriticalSecurityEvent16(type: string): boolean {
  return CRITICAL_SECURITY_EVENT_TYPES_16.has(type);
}
