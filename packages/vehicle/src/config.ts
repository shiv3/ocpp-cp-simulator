import type {
  ChargingIntent,
  VehicleBehaviorPolicy,
  VehicleBehaviorSpec,
} from "./contracts";
import { vehicleBehaviorSpecProblem } from "./evaluate";
import {
  isVehicleBehaviorPresetId,
  VEHICLE_BEHAVIOR_PRESETS,
  type VehicleBehaviorPresetId,
} from "./presets";

/**
 * The stored form of a behavior: a preset, a policy, or a preset with parts
 * overridden. Plain JSON, so it can live in settings, a scenario file or a
 * control-plane write.
 */
export interface VehicleBehaviorConfig {
  readonly preset?: VehicleBehaviorPresetId;
  /** Overrides the preset's policy. */
  readonly policy?: VehicleBehaviorPolicy;
  /** Overrides the preset's intent, field by field. */
  readonly intent?: ChargingIntent;
  readonly stopWhenDone?: boolean;
}

/** The spec a config means, or `null` when it names no policy at all. */
export function resolveVehicleBehaviorConfig(
  config: VehicleBehaviorConfig | null | undefined,
): VehicleBehaviorSpec | null {
  if (!config) return null;
  const preset = isVehicleBehaviorPresetId(config.preset)
    ? (VEHICLE_BEHAVIOR_PRESETS[config.preset] as VehicleBehaviorSpec)
    : undefined;
  const policy = config.policy ?? preset?.policy;
  if (!policy) return null;
  const intent =
    preset?.intent || config.intent
      ? { ...preset?.intent, ...config.intent }
      : undefined;
  return {
    policy,
    ...(intent && { intent }),
    ...((config.stopWhenDone ?? preset?.stopWhenDone) !== undefined && {
      stopWhenDone: config.stopWhenDone ?? preset?.stopWhenDone,
    }),
  };
}

/** Why `config` is not usable, or `null`. */
export function vehicleBehaviorConfigProblem(config: unknown): string | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return "vehicleBehavior must be an object";
  }
  const { preset, policy } = config as Record<string, unknown>;
  if (preset !== undefined && !isVehicleBehaviorPresetId(preset)) {
    return `unknown vehicleBehavior preset ${String(preset)}`;
  }
  if (preset === undefined && policy === undefined) {
    return "vehicleBehavior needs a preset or a policy";
  }
  const spec = resolveVehicleBehaviorConfig(config as VehicleBehaviorConfig);
  const stopWhenDone = (config as Record<string, unknown>).stopWhenDone;
  return vehicleBehaviorSpecProblem({
    ...spec,
    stopWhenDone,
    intent: spec?.intent,
  });
}
