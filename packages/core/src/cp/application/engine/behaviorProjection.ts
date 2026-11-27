import type {
  Behavior,
  BehaviorHolderProjection,
  BehaviorOverrideProjection,
  BehaviorParamsProjection,
  BehaviorProjection,
  JsonObject,
  JsonValue,
} from "@ocpp-cp-simulator/contracts/behavior";
import { ruleOwnerKey } from "../behavior/BehaviorRegistry";
import type { RuleOwner } from "../behavior/BehaviorRegistry";
import { mergeParams } from "../behavior/paramsSchema";

/** What the lifecycle hands the projection for one behavior. */
export interface BehaviorProjectionInput {
  readonly id: string;
  readonly kind: "default" | "code";
  readonly behavior: Behavior;
  readonly dormant: boolean;
  readonly selection: JsonObject | undefined;
  /** Running scenarios' param layers, oldest first. */
  readonly layers: ReadonlyArray<{ owner: RuleOwner; params: JsonObject }>;
  readonly holds: ReadonlyArray<{ owner: RuleOwner; mode: "use" | "disable" }>;
  readonly history: { armed: number; released: number; rearmed: number };
}

function holder(
  hold: BehaviorProjectionInput["holds"][number],
  layers: BehaviorProjectionInput["layers"],
): BehaviorHolderProjection | null {
  const { owner } = hold;
  if (owner.kind !== "scenario") return null;
  const key = ruleOwnerKey(owner);
  const layer = layers.find((l) => ruleOwnerKey(l.owner) === key);
  return {
    scenarioId: owner.scenarioId,
    connectorId: owner.connectorId,
    nodeId: owner.nodeId,
    mode: hold.mode,
    paramKeys: Object.keys(layer?.params ?? {}).sort(),
  };
}

function project(input: BehaviorProjectionInput): BehaviorProjection {
  const { behavior, selection, layers, holds } = input;
  const defaults = behavior.params?.defaults ?? {};
  const effective = mergeParams(input.id, behavior.params, [
    ...(selection ? [selection] : []),
    ...layers.map((l) => l.params),
  ]);
  // The layer that decided each key: the newest scenario that set it, else the selection.
  const overrides: BehaviorOverrideProjection[] = [];
  for (const key of Object.keys(effective).sort()) {
    const value = effective[key] as JsonValue;
    const declared = Object.hasOwn(defaults, key)
      ? (defaults[key] as JsonValue)
      : null;
    if (JSON.stringify(declared) === JSON.stringify(value)) continue;
    const fromScenario = layers.some((l) => Object.hasOwn(l.params, key));
    overrides.push({
      key,
      default: declared,
      effective: value,
      source: fromScenario ? "scenario" : "selection",
    });
  }
  const heldBy = holds
    .map((hold) => holder(hold, layers))
    .filter((h): h is BehaviorHolderProjection => h !== null);
  const disabled = heldBy.some((h) => h.mode === "disable");
  const armed = heldBy.length > 0;
  const serving =
    input.kind === "default" ||
    !input.dormant ||
    heldBy.some((h) => h.mode === "use");
  return {
    id: input.id,
    kind: input.kind,
    version: null,
    declaresParams: behavior.params !== undefined,
    state: {
      selected: input.kind === "code" || selection !== undefined,
      armed,
      active: serving && !disabled,
      disabled,
    },
    heldBy,
    params: {
      defaults: { ...defaults },
      selection: { ...(selection ?? {}) },
      effective: { ...effective },
      overrides,
    },
    history: { ...input.history },
  };
}

/** The read-only projection of every behavior's resolved params. Behaviors sorted by id. */
export function projectBehaviorParams(
  inputs: readonly BehaviorProjectionInput[],
): BehaviorParamsProjection {
  return {
    schemaVersion: 1,
    behaviors: inputs
      .map(project)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

const SECRET_KEY =
  /pass(word|phrase)?|secret|token|authorization|api[-_]?key|credential|private[-_]?key/i;
const REDACTED = "[redacted]";

/**
 * Stable JSON of a projection for a snapshot: object keys sorted at every
 * depth, and the value of any param whose name looks like a secret replaced
 * (`redact`, default on). Params have no secret marker in their schema, so the
 * match is by name; pass `redact: false` only for local debugging.
 */
export function serializeBehaviorParams(
  projection: BehaviorParamsProjection,
  options: { redact?: boolean; space?: number } = {},
): string {
  const redact = options.redact !== false;
  const walk = (node: unknown, hide: boolean): unknown => {
    if (hide) return REDACTED;
    if (Array.isArray(node)) return node.map((n) => walk(n, false));
    if (typeof node !== "object" || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node).sort()) {
      out[key] = walk(
        (node as Record<string, unknown>)[key],
        redact && SECRET_KEY.test(key),
      );
    }
    return out;
  };
  // `key` of an override names a param, so its value fields are hidden too.
  const prepared = JSON.parse(
    JSON.stringify(projection),
  ) as BehaviorParamsProjection;
  if (redact) {
    for (const b of prepared.behaviors) {
      for (const o of b.params.overrides as BehaviorOverrideProjection[]) {
        if (SECRET_KEY.test(o.key)) {
          (o as { default: unknown; effective: unknown }).default = REDACTED;
          (o as { default: unknown; effective: unknown }).effective = REDACTED;
        }
      }
    }
  }
  return JSON.stringify(walk(prepared, false), null, options.space);
}
