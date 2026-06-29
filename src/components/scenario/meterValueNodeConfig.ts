import {
  AutoMeterValueConfig,
  CurvePoint,
} from "../../cp/domain/connector/MeterValueCurve";

/** Loosely-typed bag matching the ScenarioEditor node form state. */
export type MeterNodeFormData = Record<string, unknown>;

/** Fallback curve used when a MeterValue node has none configured yet. */
const DEFAULT_CURVE_POINTS: CurvePoint[] = [
  { time: 0, value: 0 },
  { time: 30, value: 50 },
];

/**
 * Build the {@link MeterValueCurveModal}'s `initialConfig` from a scenario
 * MeterValue node's form data.
 *
 * A scenario expresses "charge until battery full" through
 * `stopMode === "evSettings"` — that's what {@link ScenarioExecutor} honors,
 * not the modal's own `stopAtTargetSoc`. We surface that flag as the modal
 * checkbox so the two controls stay in sync and the checkbox round-trips
 * (otherwise it always reopened unchecked — issue #95).
 */
export function meterNodeToCurveConfig(
  formData: MeterNodeFormData,
): AutoMeterValueConfig {
  return {
    enabled: true,
    intervalSeconds: (formData.incrementInterval as number) || 10,
    curvePoints:
      (formData.curvePoints as CurvePoint[] | undefined) ??
      DEFAULT_CURVE_POINTS,
    autoCalculateInterval:
      (formData.autoCalculateInterval as boolean | undefined) || false,
    stopAtTargetSoc: formData.stopMode === "evSettings",
  };
}

/**
 * Merge a saved modal config back onto the MeterValue node form data.
 *
 * The modal's `stopAtTargetSoc` checkbox maps to the scenario's `stopMode`
 * ("evSettings" when checked, "manual" when cleared) so the executor actually
 * stops at the EV's target SoC. Without this, the checkbox was dropped on save
 * and never took effect (issue #95).
 */
export function applyCurveConfigToMeterNode(
  formData: MeterNodeFormData,
  config: AutoMeterValueConfig,
): MeterNodeFormData {
  return {
    ...formData,
    curvePoints: config.curvePoints,
    incrementInterval: config.intervalSeconds,
    autoCalculateInterval: config.autoCalculateInterval,
    stopMode: config.stopAtTargetSoc ? "evSettings" : "manual",
  };
}
