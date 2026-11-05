/**
 * The OCPP 2.x `MonitoringCtrlr` values a station publishes (#538), as the
 * read-only runtime configuration keys behind the device-model variables
 * (2.0.1 Part 2 §2.11, 2.1 Part 2 §2.13).
 */

/** Configuration keys of the MonitoringCtrlr variables. */
export const MONITORING_CTRLR_KEYS = {
  /** `ItemsPerMessage`, instance `SetVariableMonitoring` (required). */
  itemsPerSetVariableMonitoring: "ItemsPerMessageSetVariableMonitoring",
  /** `BytesPerMessage`, instance `SetVariableMonitoring` (required). */
  bytesPerSetVariableMonitoring: "BytesPerMessageSetVariableMonitoring",
  /** `ItemsPerMessage`, instance `ClearVariableMonitoring`. */
  itemsPerClearVariableMonitoring: "ItemsPerMessageClearVariableMonitoring",
  /** `BytesPerMessage`, instance `ClearVariableMonitoring`. */
  bytesPerClearVariableMonitoring: "BytesPerMessageClearVariableMonitoring",
  /** `ActiveMonitoringLevel`: the SetMonitoringLevel severity in force. */
  activeMonitoringLevel: "ActiveMonitoringLevel",
  /** `ActiveMonitoringBase`: the SetMonitoringBase value last set. */
  activeMonitoringBase: "ActiveMonitoringBase",
} as const;

/**
 * OCPP 2.0.1 / 2.1 N07.FR.04 and N08.FR.03: while offline, the station
 * queues the NotifyEvent of a monitor whose severity number is equal to or
 * lower than `MonitoringCtrlr.OfflineQueuingSeverity`; with the variable
 * unset, nothing is queued ("When set", Part 2 §2.11.7 / 2.1 §2.13.7).
 * That variable is the persisted ReadWrite configuration key
 * `OfflineQueuingSeverity`, not one of the runtime keys above.
 */
export function isQueuedOffline(
  severity: number,
  offlineQueuingSeverity: number | undefined,
): boolean {
  return (
    offlineQueuingSeverity !== undefined && severity <= offlineQueuingSeverity
  );
}

/**
 * The most items (setMonitoringData, ids) the station advertises for one
 * SetVariableMonitoring / ClearVariableMonitoring request. They bound what
 * the CSMS sends (N04.FR.09, N06.FR.04); the station does not refuse a
 * larger request, which the spec leaves optional (N06.FR.06, FR.07).
 */
export const MONITORING_REQUEST_MAX_ITEMS = 100;

/** The largest SetVariableMonitoring / ClearVariableMonitoring request, in
 *  bytes, the station advertises (same caveat). */
export const MONITORING_REQUEST_MAX_BYTES = 65536;
