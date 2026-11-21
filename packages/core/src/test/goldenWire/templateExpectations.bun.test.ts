// Every built-in template declares what it needs from the CSMS
// (`csmsExpectations`) and what a run on its intended path must show
// (`assertions`). This test plays the CSMS operator from the declared
// expectations alone — the calls with their example payloads, the answers — and
// checks that each template then ends with every assertion passed, and that the
// assertions are not vacuous (none of them holds on an empty transcript, except
// the deliberate "nothing happens" ones).
import { describe, expect, test } from "bun:test";
import { evaluateAssertions } from "../../cp/application/verification/ScenarioAssertions";
import type {
  AssertionSpec,
  CsmsExpectations,
  ScenarioDefinition,
} from "../../cp/application/scenario/ScenarioTypes";
import { validateScenarioGraph } from "../../scenario/scenarioGraphValidator";
import { scenarioTemplates } from "../../utils/scenarioTemplates";
import type { CsmsResponder } from "./FakeCsms";
import { Rig } from "./rig";
import { runTemplate, type PayloadSource } from "./scenarioCases";
import { toFrames } from "./toFrames";

const CSMS_TRIGGER_ACTIONS: Record<string, string> = {
  remoteStartTrigger: "RemoteStartTransaction",
  remoteStopTrigger: "RemoteStopTransaction",
  reservationTrigger: "ReserveNow",
  unlockOutcome: "UnlockConnector",
};

/** Resolve the placeholders of an example payload (see {@link CsmsExpectations}). */
function resolve(rig: Rig, value: unknown): unknown {
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

function respondersOf(exp: CsmsExpectations): Record<string, CsmsResponder> {
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

/** Templates that run long: shortened so a run ends in seconds. */
function shorten(def: ScenarioDefinition): void {
  if (def.templateId === "essential-cp-behavior") {
    def.evSettings = {
      ...def.evSettings,
      batteryCapacityKwh: 1,
      initialSoc: 78,
      targetSoc: 80,
    };
  }
  if (def.templateId === "full-charging-cycle") {
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

/** Templates run for a window, then stopped: they never end on their own, or the run does not report its end. */
const WINDOW_MS: Record<string, number> = {
  "full-charging-cycle": 6000,
  "status-triggered-actions": 1500,
  "multi-status-monitor": 3000,
  "smart-charging": 3500,
};

/** Assertions that hold on an empty transcript by design ("nothing happened"). */
const MAY_HOLD_WHEN_EMPTY = new Set<string>(["no_unexpected", "ocpp_absent"]);

describe("template metadata", () => {
  test("the shipped templates all declare versions, expectations and assertions", () => {
    for (const t of scenarioTemplates) {
      const def = t.createScenario("CP", 1);
      expect(def.ocppVersions?.length, `${t.id} ocppVersions`).toBeGreaterThan(
        0,
      );
      expect(def.csmsExpectations, `${t.id} csmsExpectations`).toBeDefined();
      expect(def.assertions?.length, `${t.id} assertions`).toBeGreaterThan(0);
    }
  });

  for (const t of scenarioTemplates) {
    test(`${t.id}: expectations match the graph`, () => {
      const def = t.createScenario("CP", 1);
      expect(validateScenarioGraph(def)).toEqual([]);
      const ids = new Set(def.nodes.map((n) => n.id));
      const ass = new Set<string>();
      for (const a of def.assertions ?? []) {
        expect(ass.has(a.id), `duplicate assertion id ${a.id}`).toBe(false);
        ass.add(a.id);
      }
      // Every call the metadata lists is waited for by a node of the graph:
      // a csmsCallTrigger on that action, a dedicated trigger node, or the
      // delay window of an unlock outcome.
      for (const c of def.csmsExpectations?.calls ?? []) {
        if (c.node)
          expect(ids.has(c.node), `${t.id} node ${c.node}`).toBe(true);
      }
      const triggers = def.nodes.flatMap((n) => {
        const data = n.data as Record<string, unknown>;
        if (n.type === "csmsCallTrigger") return [String(data.action)];
        const dedicated = CSMS_TRIGGER_ACTIONS[String(n.type)];
        return dedicated ? [dedicated] : [];
      });
      const listed = (def.csmsExpectations?.calls ?? [])
        .filter((c) => !c.optional)
        .map((c) => c.action);
      if (def.templateId !== "cert16-octt-strictness-probe") {
        // The graph's CSMS-waiting nodes and the metadata's calls name the same
        // actions (RequestStartTransaction for 2.x is a csmsCallTrigger).
        expect([...listed].sort(), `${t.id} calls`).toEqual(
          [...triggers].sort(),
        );
      }
    });
  }
});

describe("a run driven by the declared expectations passes its assertions", () => {
  for (const t of scenarioTemplates) {
    const def0 = t.createScenario("CP", 1);
    const version = def0.ocppVersions?.includes("1.6") ? "1.6" : "2.0.1";
    test.concurrent(
      `${t.id} (${version})`,
      async () => {
        const exp = def0.csmsExpectations ?? {};
        const rig = await Rig.create({
          version,
          responders: respondersOf(exp),
        });
        try {
          const first = rig.csms.frames.length;
          const queue = new Map<string, unknown[]>();
          for (const c of exp.calls ?? []) {
            if (c.example === undefined) continue;
            queue.set(c.action, [...(queue.get(c.action) ?? []), c.example]);
          }
          const payloadFor: PayloadSource = (r, action, nth) => {
            const example = queue.get(action)?.[nth];
            if (example === undefined) {
              throw new Error(`${t.id}: no example for ${action} #${nth}`);
            }
            return resolve(r, example);
          };
          await runTemplate(rig, t.id, {
            edit: shorten,
            payloadFor,
            windowMs: WINDOW_MS[t.id] ?? null,
          });
          await new Promise((resolveTimer) => setTimeout(resolveTimer, 0));
          await rig.csms.settle(400);
          const frames = toFrames(rig.csms.frames.slice(first));
          const specs = (def0.assertions ?? []) as AssertionSpec[];
          const results = evaluateAssertions(specs, frames);
          expect(results.filter((r) => r.status !== "passed")).toEqual([]);
          const empty = evaluateAssertions(specs, []);
          const vacuous = specs.filter(
            (s, i) =>
              empty[i].status === "passed" && !MAY_HOLD_WHEN_EMPTY.has(s.type),
          );
          expect(vacuous).toEqual([]);
        } finally {
          await rig.dispose();
        }
      },
      120_000,
    );
  }
});

describe("open-ended templates are bounded (maxDurationSeconds)", () => {
  const BOUNDED = [
    "status-triggered-actions",
    "multi-status-monitor",
    "smart-charging",
    "full-charging-cycle",
    "remote-start-auto-meter",
  ];

  test("each declares a bound and says what ends it", () => {
    for (const id of BOUNDED) {
      const def = scenarioTemplates
        .find((t) => t.id === id)!
        .createScenario("CP", 1);
      expect(def.maxDurationSeconds, id).toBeGreaterThan(0);
      expect(def.csmsExpectations?.note, id).toMatch(/maxDurationSeconds/);
    }
  });

  test("status-triggered-actions, a Heartbeat loop with no end of its own, ends at its bound", async () => {
    const rig = await Rig.create({ version: "1.6" });
    try {
      const started = Date.now();
      // Without the bound this run never completes: runTemplate fails after 80 s.
      await runTemplate(rig, "status-triggered-actions", {
        windowMs: null,
        edit: (def) => {
          def.maxDurationSeconds = 3;
        },
      });
      expect(Date.now() - started).toBeLessThan(20_000);
      const heartbeats = rig.csms.frames.filter(
        (f) => f.dir === "CP>" && f.action === "Heartbeat",
      );
      expect(heartbeats.length).toBeGreaterThan(0);
    } finally {
      await rig.dispose();
    }
  }, 60_000);
});
