import type {
  Behavior,
  BehaviorCapability,
} from "@ocpp-cp-sim/contracts/behavior";
import { isOcpp2Version, isSoapVersion } from "../../domain/types/OcppVersion";
import { csmsActionAliases } from "../../domain/types/csmsActionNames";
import { DEFAULT_ACTIONS } from "./behaviors/defaultActions";
import { paramsDeclarationProblem } from "../behavior/paramsSchema";

/** The closed set of `requires` names. */
const CAPABILITIES: ReadonlySet<string> = new Set([
  "ocpp1.6",
  "ocpp2.x",
  "physical",
  "raw-frames",
]);

/** The id prefix of the built-in behaviors; a user behavior may not use it. */
export const RESERVED_PREFIX = "default.";

/** Does a default behavior answer `action` or one of its spellings (any version)? */
export function hasDefaultAction(action: string): boolean {
  return csmsActionAliases(action).some((name) => DEFAULT_ACTIONS.has(name));
}

/**
 * What every engine refuses whatever the station: an unknown `api`, a missing,
 * reserved or object-member id, and `mode: "extend"` on an action no default
 * behavior answers. Null when the behavior passes. The behavior library runs
 * it when a file loads, so a refused behavior never reaches a station.
 * `hasDefault` tells which actions have a default (the engine passes its own).
 */
export function behaviorShapeProblem(
  behavior: Behavior,
  hasDefault: (action: string) => boolean = hasDefaultAction,
): string | null {
  if (behavior.api !== 1) {
    return `Behavior ${String(behavior.id)}: unsupported api ${String(behavior.api)}`;
  }
  if (typeof behavior.id !== "string" || !behavior.id) {
    return "A behavior needs an id";
  }
  if (behavior.id.startsWith(RESERVED_PREFIX)) {
    return `Behavior id "${behavior.id}" is reserved: ids starting with "${RESERVED_PREFIX}" belong to the built-in behaviors`;
  }
  if (behavior.id in Object.prototype) {
    return `Behavior id "${behavior.id}" is not allowed: it names a member of every object`;
  }
  for (const capability of behavior.requires ?? []) {
    if (!CAPABILITIES.has(capability)) {
      return `Behavior ${behavior.id}: requires "${capability}", which is not a capability (${[...CAPABILITIES].join(", ")})`;
    }
  }
  const params = paramsDeclarationProblem(behavior.params);
  if (params) return `Behavior ${behavior.id}: ${params}`;
  for (const [action, call] of Object.entries(behavior.onCall ?? {})) {
    if (call.mode === "extend" && !hasDefault(action)) {
      return `Behavior ${behavior.id}: onCall.${action} uses mode "extend", but ${action} has no default behavior to extend; use mode "replace"`;
    }
  }
  return null;
}

/** What a station offers a behavior: the facts `requires` is checked against. */
export interface StationFacts {
  readonly ocppVersion: string;
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
