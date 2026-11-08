/**
 * OCPP 2.0.1 / 2.1 Appendix 1 "Security events": the types the
 * specification flags critical. A04.FR.02: a Charging Station SHALL queue a
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
]);

export function isCriticalSecurityEvent(type: string): boolean {
  return CRITICAL_SECURITY_EVENT_TYPES.has(type);
}
