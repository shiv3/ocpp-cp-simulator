import { MONITORING_CTRLR_KEYS } from "./monitoringCtrlrKeys";
import type { VariableMonitor } from "./VariableMonitor";

/**
 * The monitors an OCPP 2.x station ships with (#538), as its firmware would
 * define them. N03 leaves the content to the manufacturer: these watch the
 * read-only MonitoringCtrlr limits, which never change, so they show up in
 * GetMonitoringReport and obey SetMonitoringBase / ClearVariableMonitoring
 * without ever sending a NotifyEvent on their own.
 *
 * - A `HardWiredMonitor` cannot be cleared (N06.FR.03) or replaced
 *   (N04.FR.18) and survives every monitoring base (N03.FR.05).
 * - A `PreconfiguredMonitor` is active under `All` and `FactoryDefault`
 *   (N03.FR.03, FR.04), deleted by `HardWiredOnly` (N03.FR.05) or by
 *   ClearVariableMonitoring, and becomes custom when replaced (N04.FR.15).
 *
 * Their ids sit far above the ids allocated to custom monitors (from 1),
 * which skip them anyway, so a FactoryDefault always restores a
 * preconfigured monitor under its original id.
 */
export const DEFAULT_MONITOR_CATALOG: readonly VariableMonitor[] = [
  {
    id: 1000001,
    type: "Delta",
    severity: 2,
    value: 1,
    transaction: false,
    component: { name: "MonitoringCtrlr" },
    variable: { name: "ItemsPerMessage", instance: "SetVariableMonitoring" },
    valueKey: MONITORING_CTRLR_KEYS.itemsPerSetVariableMonitoring,
    origin: "HardWiredMonitor",
  },
  {
    id: 1000002,
    type: "Delta",
    severity: 5,
    value: 1,
    transaction: false,
    component: { name: "MonitoringCtrlr" },
    variable: { name: "BytesPerMessage", instance: "SetVariableMonitoring" },
    valueKey: MONITORING_CTRLR_KEYS.bytesPerSetVariableMonitoring,
    origin: "PreconfiguredMonitor",
  },
  {
    id: 1000003,
    type: "Delta",
    severity: 8,
    value: 1,
    transaction: false,
    component: { name: "MonitoringCtrlr" },
    variable: { name: "ItemsPerMessage", instance: "ClearVariableMonitoring" },
    valueKey: MONITORING_CTRLR_KEYS.itemsPerClearVariableMonitoring,
    origin: "PreconfiguredMonitor",
  },
];
