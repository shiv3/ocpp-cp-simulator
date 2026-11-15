// Builders for the Device Model variable tables (#604), split out of
// DeviceModelRegistry.ts (#877).
import type { DeviceModelVariableDef } from "./DeviceModelRegistry";

/** A `Persistent` ConfigurationStore key shared with OCPP 1.6 unless noted. */
export const persistent = (
  component: string,
  variable: string,
  valueKey: string,
  rest: Omit<
    DeviceModelVariableDef,
    "component" | "variable" | "valueKey" | "persistence" | "sharedWith16"
  > & { sharedWith16?: boolean },
): DeviceModelVariableDef => ({
  component,
  variable,
  valueKey,
  persistence: "Persistent",
  sharedWith16: true,
  ...rest,
});

/** A value the station makes at runtime: Volatile, ReadOnly, 2.x only. */
export const runtime = (
  component: string,
  variable: string,
  valueKey: string,
  rest: Omit<
    DeviceModelVariableDef,
    | "component"
    | "variable"
    | "valueKey"
    | "persistence"
    | "sharedWith16"
    | "mutability"
  >,
): DeviceModelVariableDef => ({
  component,
  variable,
  valueKey,
  persistence: "Volatile",
  sharedWith16: false,
  mutability: "ReadOnly",
  ...rest,
});

/**
 * The measurands the meter value builder models (`MeterValueBuilder`) that are
 * in the 2.x `MeasurandEnumType` (no `Temperature` or `RPM`, 1.6 measurands;
 * #714).
 */
export const METER_MEASURANDS: readonly string[] = [
  "Energy.Active.Import.Register",
  "Energy.Active.Import.Interval",
  "Energy.Active.Export.Register",
  "Energy.Active.Export.Interval",
  "Energy.Reactive.Import.Register",
  "Energy.Reactive.Import.Interval",
  "Energy.Reactive.Export.Register",
  "Energy.Reactive.Export.Interval",
  "Voltage",
  "Current.Import",
  "Current.Export",
  "Current.Offered",
  "Power.Active.Import",
  "Power.Active.Export",
  "Power.Reactive.Import",
  "Power.Reactive.Export",
  "Power.Offered",
  "Power.Factor",
  "SoC",
  "Frequency",
];
