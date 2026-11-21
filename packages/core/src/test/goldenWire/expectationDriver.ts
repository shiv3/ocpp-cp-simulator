// Plays the CSMS operator of a template from its declared `csmsExpectations`
// alone: the example payload of each CSMS call (placeholders resolved) and the
// answers the CSMS gives to the charge point's calls.
import type {
  CsmsExpectations,
  ScenarioDefinition,
} from "../../cp/application/scenario/ScenarioTypes";
import type { CsmsResponder } from "./FakeCsms";
import type { Rig } from "./rig";
import type { PayloadSource } from "./scenarioCases";

/** Resolve the placeholders of an example payload (see {@link CsmsExpectations}). */
export function resolve(rig: Rig, value: unknown): unknown {
  if (typeof value === "string") {
    if (value === "<transactionId>") return rig.transactionId(1);
    if (value === "<uploadUrl>") return rig.uploadUrl();
    if (value === "<firmwareUrl>") return "https://fw.example.test/fw.bin";
    const now = /^<now\+(\d+)s>$/.exec(value);
    if (now) return new Date(Date.now() + Number(now[1]) * 1000).toISOString();
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolve(rig, v));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolve(rig, v)]),
    );
  }
  return value;
}

function subset(want: unknown, got: unknown): boolean {
  if (want && typeof want === "object" && !Array.isArray(want)) {
    return (
      !!got &&
      typeof got === "object" &&
      Object.entries(want).every(([k, v]) =>
        subset(v, (got as Record<string, unknown>)[k]),
      )
    );
  }
  return JSON.stringify(want) === JSON.stringify(got);
}

export function respondersOf(
  exp: CsmsExpectations,
): Record<string, CsmsResponder> {
  const out: Record<string, CsmsResponder> = {};
  for (const action of new Set((exp.answers ?? []).map((a) => a.action))) {
    const rules = (exp.answers ?? []).filter((a) => a.action === action);
    out[action] = (payload) => {
      const hit = rules.find((r) => !r.when || subset(r.when, payload));
      if (hit) return hit.respond;
      if (action === "Authorize") {
        return "idToken" in payload
          ? { idTokenInfo: { status: "Accepted" } }
          : { idTagInfo: { status: "Accepted" } };
      }
      return { status: "Accepted" };
    };
  }
  return out;
}

/** The 1.6 template a `-201` variant copies, else the template itself. */
function base(def: ScenarioDefinition): string | undefined {
  return def.templateId?.replace(/-201$/, "");
}

/** Templates that run long: shortened so a run ends in seconds. */
export function shorten(def: ScenarioDefinition): void {
  if (base(def) === "essential-cp-behavior") {
    def.evSettings = {
      ...def.evSettings,
      batteryCapacityKwh: 1,
      initialSoc: 78,
      targetSoc: 80,
    };
  }
  if (base(def) === "full-charging-cycle") {
    for (const node of def.nodes) {
      const data = node.data as Record<string, unknown>;
      if (node.type === "meterValue") {
        data.incrementInterval = 1;
        data.maxTime = 2;
      }
      if (node.type === "delay") data.delaySeconds = 0.2;
    }
  }
}

/** The payload of each CSMS call, in the order the expectations list them. */
export function payloadSourceOf(def: ScenarioDefinition): PayloadSource {
  const queue = new Map<string, unknown[]>();
  for (const c of def.csmsExpectations?.calls ?? []) {
    if (c.example === undefined) continue;
    queue.set(c.action, [...(queue.get(c.action) ?? []), c.example]);
  }
  return (rig, action, nth) => {
    const example = queue.get(action)?.[nth];
    if (example === undefined) {
      throw new Error(`${def.templateId}: no example for ${action} #${nth}`);
    }
    return resolve(rig, example);
  };
}
