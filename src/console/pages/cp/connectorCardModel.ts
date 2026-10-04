/*
 * What the connector card computes from its data, apart from the components
 * that draw it (kept out of the component files for Fast Refresh).
 */
import { EV_PRESETS, type EVSettings } from "@/cp/domain/connector/EVSettings";
import { OCPPStatus } from "@/cp/domain/types/OcppTypes";

import { curveDurationMin, curvePeakKw, type PowerPoint } from "./powerCurve";

export type BatteryTone = "charging" | "idle" | "full" | "faulted";

/** Fill colour by state: a fault wins, then a reached target, then charging. */
export function batteryTone(
  status: OCPPStatus,
  soc: number | null,
  targetSoc: number,
): BatteryTone {
  if (status === OCPPStatus.Faulted) return "faulted";
  if (soc != null && soc >= targetSoc) return "full";
  if (status === OCPPStatus.Charging) return "charging";
  return "idle";
}

/** The vehicle's name: the settings' model, else the preset whose battery
 *  and power match, else "Custom EV". */
export function evDisplayName(ev: EVSettings): string {
  if (ev.modelName && ev.modelName !== "Custom") return ev.modelName;
  const preset = Object.entries(EV_PRESETS).find(
    ([name, values]) =>
      name !== "Custom" &&
      values.batteryCapacityKwh === ev.batteryCapacityKwh &&
      values.maxChargingPowerKw === ev.maxChargingPowerKw,
  );
  return preset?.[0] ?? "Custom EV";
}

/** The chart's viewBox and plot margins, in SVG units. */
export const CURVE_VIEW = {
  width: 640,
  height: 220,
  left: 44,
  right: 12,
  top: 14,
  bottom: 28,
} as const;

function niceStep(x: number): number {
  const base = 10 ** Math.floor(Math.log10(Math.max(x, 1e-9)));
  for (const m of [1, 1.5, 2, 2.5, 3, 5, 10]) {
    if (m * base >= x) return m * base;
  }
  return 10 * base;
}

/** Axis ends: four time ticks over the curve, three power ticks over the
 *  higher of the cap and the peak. */
export function curveScale(
  points: readonly PowerPoint[],
  capKw: number,
): { xMax: number; yMax: number } {
  const xStep = niceStep(Math.max(curveDurationMin(points), 4) / 4);
  const yStep = niceStep((Math.max(capKw, curvePeakKw(points), 1) * 1.05) / 3);
  return { xMax: xStep * 4, yMax: yStep * 3 };
}
