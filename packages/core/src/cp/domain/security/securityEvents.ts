/**
 * OCPP 2.0.1 edition 4 and 2.1 edition 2, Part 2 Appendices (v1.5 / v2.1),
 * Chapter 1 "Security Events": the 16 types whose "Critical" column is Yes.
 * The two tables are identical. The 1.6 Security Whitepaper lists only the
 * first seven; the other nine were added for 2.x. A04.FR.02: a Charging Station SHALL queue a
 * critical security event while it is offline and send it once the
 * connection is back (#552). Every other type, and any type of a vendor's
 * own, is not queued: it is dropped while offline.
 */
export const CRITICAL_SECURITY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "FirmwareUpdated",
  "SettingSystemTime",
  "StartupOfTheDevice",
  "ResetOrReboot",
  "SecurityLogWasCleared",
  "MemoryExhaustion",
  "TamperDetectionActivated",
  "InvalidFirmwareSignature",
  "InvalidFirmwareSigningCertificate",
  "InvalidCsmsCertificate",
  "InvalidChargingStationCertificate",
  "DiscardedRenewedClientCertificate",
  "InvalidTLSVersion",
  "InvalidTLSCipherSuite",
  "MaintenanceLoginAccepted",
  "MaintenanceLoginFailed",
]);

export function isCriticalSecurityEvent(type: string): boolean {
  return CRITICAL_SECURITY_EVENT_TYPES.has(type);
}
