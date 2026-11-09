import type { VehicleBehaviorSpec } from "./contracts";

const MINUTE = 60_000;

/**
 * Reusable behaviors, selected by id (`vehicleBehavior: { preset }`) from any
 * surface that can write the EV settings. Plain data: copy one and edit it
 * for a variant.
 */
export const VEHICLE_BEHAVIOR_PRESETS = {
  /** Asks for energy from the plug-in on and never completes by itself. */
  immediate: { policy: { type: "immediate" } },
  /** Charges at once and stops asking at the session's target SoC. */
  "target-soc": { policy: { type: "target-soc" } },
  /** Connects, waits 15 minutes, then charges. */
  "delayed-15min": { policy: { type: "delayed", delayMs: 15 * MINUTE } },
  /** Charges 22:00-07:00 (UTC) only. */
  overnight: {
    policy: {
      type: "scheduled-window",
      windows: [{ startMinute: 22 * 60, endMinute: 7 * 60 }],
    },
  },
  /** Pauses for 2 minutes after 5 minutes of charging, then resumes. */
  "ev-pause-resume": {
    policy: {
      type: "manual-suspend",
      pauses: [{ afterMs: 5 * MINUTE, durationMs: 2 * MINUTE }],
    },
  },
  /** Cuts its own demand to 3.7 kW from minute 5 and restores it at minute 10. */
  "demand-dip": {
    policy: {
      type: "demand-steps",
      steps: [
        { afterMs: 5 * MINUTE, maxPowerW: 3700 },
        { afterMs: 10 * MINUTE, maxPowerW: null },
      ],
    },
  },
} as const satisfies Record<string, VehicleBehaviorSpec>;

export type VehicleBehaviorPresetId = keyof typeof VEHICLE_BEHAVIOR_PRESETS;

export function isVehicleBehaviorPresetId(
  id: unknown,
): id is VehicleBehaviorPresetId {
  return (
    typeof id === "string" &&
    Object.prototype.hasOwnProperty.call(VEHICLE_BEHAVIOR_PRESETS, id)
  );
}
