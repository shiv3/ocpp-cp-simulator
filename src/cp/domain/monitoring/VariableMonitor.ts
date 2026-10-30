/**
 * OCPP 2.x variable monitoring (use cases N02–N07) — domain types.
 *
 * A monitor watches one device-model value. The simulator's device model is
 * the 2.x component/variable → 1.6 configuration key mapping, so a monitor
 * carries both the component/variable the CSMS addressed (echoed in reports
 * and events) and the `valueKey` of the configuration value it watches
 * (the value `GetVariables` / `SetVariables` read and write).
 */

/** Monitor types the simulator implements (N07.FR.16–FR.19). */
export const SUPPORTED_MONITOR_TYPES = [
  "UpperThreshold",
  "LowerThreshold",
  "Delta",
] as const;

export type SupportedMonitorType = (typeof SUPPORTED_MONITOR_TYPES)[number];

export function parseSupportedMonitorType(
  raw: string,
): SupportedMonitorType | null {
  return (SUPPORTED_MONITOR_TYPES as readonly string[]).includes(raw)
    ? (raw as SupportedMonitorType)
    : null;
}

export function isThresholdMonitorType(type: SupportedMonitorType): boolean {
  return type === "UpperThreshold" || type === "LowerThreshold";
}

/**
 * Where a monitor comes from; the values match OCPP's
 * `EventNotificationEnumType` minus `HardWiredNotification` (which has no
 * monitor). Only `CustomMonitor` is created today: hardwired and
 * preconfigured catalogs are not modelled yet.
 */
export type MonitorOrigin =
  "CustomMonitor" | "PreconfiguredMonitor" | "HardWiredMonitor";

/** Monitor severity range, 0 (Danger) to 9 (Debug). */
export const MIN_MONITOR_SEVERITY = 0;
export const MAX_MONITOR_SEVERITY = 9;

export function isValidMonitorSeverity(severity: number): boolean {
  return (
    Number.isInteger(severity) &&
    severity >= MIN_MONITOR_SEVERITY &&
    severity <= MAX_MONITOR_SEVERITY
  );
}

export interface MonitorEvse {
  readonly id: number;
  readonly connectorId?: number;
}

export interface MonitorComponent {
  readonly name: string;
  readonly instance?: string;
  readonly evse?: MonitorEvse;
}

export interface MonitorVariable {
  readonly name: string;
  readonly instance?: string;
}

/** What the monitor needs to know about the watched value's type. */
export interface MonitoredValueType {
  /** `true` for integer / decimal variables. */
  readonly numeric: boolean;
  /** Inclusive bounds of a numeric variable, when it has any (N04.FR.06). */
  readonly min?: number;
  readonly max?: number;
}

export interface VariableMonitor {
  readonly id: number;
  readonly type: SupportedMonitorType;
  readonly severity: number;
  /** Threshold for Upper/LowerThreshold, step for Delta. */
  readonly value: number;
  /** Monitor only while a transaction is running. */
  readonly transaction: boolean;
  readonly component: MonitorComponent;
  readonly variable: MonitorVariable;
  /** Configuration key of the device-model value this monitor watches. */
  readonly valueKey: string;
  readonly origin: MonitorOrigin;
}

/** Same component/variable combination, every addressing field included. */
export function sameMonitorTarget(
  a: Pick<VariableMonitor, "component" | "variable">,
  b: Pick<VariableMonitor, "component" | "variable">,
): boolean {
  return (
    a.component.name === b.component.name &&
    a.component.instance === b.component.instance &&
    a.component.evse?.id === b.component.evse?.id &&
    a.component.evse?.connectorId === b.component.evse?.connectorId &&
    a.variable.name === b.variable.name &&
    a.variable.instance === b.variable.instance
  );
}
