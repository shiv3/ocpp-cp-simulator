import type {
  Behavior,
  BehaviorCapability,
} from "@ocpp-cp-sim/contracts/behavior";
import { isOcpp2Version, isSoapVersion } from "../../domain/types/OcppVersion";

/** What a station offers a behavior: the facts `requires` is checked against. */
export interface StationFacts {
  readonly ocppVersion: string;
  /** True when the station's clock is a virtual one. */
  readonly virtualTime: boolean;
}

/** Why a station cannot take a capability the behavior lists, or null. */
export function unmetCapability(
  capability: BehaviorCapability,
  station: StationFacts,
): string | null {
  const version = station.ocppVersion;
  switch (capability) {
    case "ocpp1.6":
      return version === "OCPP-1.6J" ? null : `the station speaks ${version}`;
    case "ocpp2.x":
      return isOcpp2Version(version) ? null : `the station speaks ${version}`;
    case "virtual-time":
      return station.virtualTime ? null : "the station runs on real time";
    default:
      return null;
  }
}

/**
 * Everything about whether `behavior` fits a station that can be known from the
 * station's facts alone, without building the station: `requires` and
 * `beforeSend` on a SOAP station. Null when it fits. A caller that is about to
 * persist a selection runs this first, so a refusal changes nothing.
 */
export function behaviorFitProblem(
  behavior: Behavior,
  station: StationFacts,
): string | null {
  if (behavior.beforeSend && isSoapVersion(station.ocppVersion)) {
    return `Behavior ${behavior.id} uses beforeSend, which needs an OCPP-J station; ${station.ocppVersion} is SOAP`;
  }
  for (const capability of behavior.requires ?? []) {
    const problem = unmetCapability(capability, station);
    if (problem) {
      return `Behavior ${behavior.id} requires ${capability}: ${problem}`;
    }
  }
  return null;
}
