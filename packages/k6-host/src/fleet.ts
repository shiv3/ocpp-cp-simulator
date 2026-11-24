// What one k6 VU does: drive its slice of the fleet.
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { runCharger, type ChargerHooks } from "./charger";
import type { FleetConfig } from "./config";
import { chargerId, chargerIndex, startDelayMs } from "./ids";

export interface Identity {
  readonly cpId: string;
  readonly basicPassword?: string;
}

export interface VuInputs {
  readonly scenario?: ScenarioDefinition;
  readonly behaviors?: readonly Behavior[];
  /** Identities by charger index (from CP_IDS_FILE), when given. */
  readonly identities?: ArrayLike<Identity> | null;
  /** Connectors per charger. */
  readonly connectors: number;
}

/** Run every charger slot of one VU to completion, in parallel. */
export async function runVu(
  config: FleetConfig,
  vuIdInTest: number,
  inputs: VuInputs,
  hooks: ChargerHooks,
  now: () => number = Date.now,
): Promise<void> {
  const deadlineAt =
    now() + (config.rampSeconds + config.durationSeconds) * 1000;
  const runs: Promise<void>[] = [];
  for (let slot = 0; slot < config.chargersPerVu; slot++) {
    const index = chargerIndex(config, vuIdInTest, slot);
    if (index === null) continue;
    const identity = inputs.identities?.[index];
    if (inputs.identities && !identity) {
      throw new Error(
        `CP_IDS_FILE has ${inputs.identities.length} identities but charger ${index + 1} of ${config.chargers} needs one`,
      );
    }
    runs.push(
      runCharger(
        {
          id: identity?.cpId ?? chargerId(config, index),
          csmsUrl: config.csmsUrl,
          ...((identity?.basicPassword ?? config.basicPassword)
            ? {
                basicPassword: (identity?.basicPassword ??
                  config.basicPassword)!,
              }
            : {}),
          ...(inputs.scenario ? { scenario: inputs.scenario } : {}),
          ...(inputs.behaviors ? { behaviors: inputs.behaviors } : {}),
          profile: config.profile,
          deadlineAt,
          startDelayMs: startDelayMs(
            index,
            config.chargers,
            config.rampSeconds * 1000,
          ),
          connectors: inputs.connectors,
          ...(config.seed ? { seed: config.seed } : {}),
          ...(config.meterValueSampleIntervalS
            ? { meterValueSampleIntervalS: config.meterValueSampleIntervalS }
            : {}),
        },
        hooks,
      ).catch((error: unknown) => {
        hooks.log(
          `charger ${index}: ${error instanceof Error ? error.message : String(error)}`,
        );
        hooks.cycle(false, 0);
      }),
    );
  }
  await Promise.all(runs);
}
