// Record a run of a behavior as a scenario (#654, step 2).
//
// The behavior runs on a real station on a VirtualClock with a seed, wired to
// the fake CSMS of the golden wire test (see runBehavior.ts). What the station
// puts on the wire after the CSMS CALL that triggers the behavior, and when
// (virtual time), is mapped to scenario nodes:
//
//   CSMS CALL            -> csmsCallTrigger, behavior "replace"
//   station answer       -> callResponse (accepted / rejected / result / error / none)
//   gap between effects  -> delay
//   status notification  -> notify
//   any other CALL       -> ocppCall
//
// A recording is a *trace* of one run: a branch the run did not take, a draw
// other than the seed's and a decision on state are not in it. It stays data
// and never computes, so it is not a conversion of the behavior (the plan of
// #654 rejects that). Runs under `bun test` only, like runBehavior.
import type {
  Behavior,
  JsonObject,
} from "@ocpp-cp-simulator/contracts/behavior";
import type { Edge } from "@xyflow/react";
import {
  SCENARIO_SCHEMA_VERSION,
  type ScenarioDefinition,
  type ScenarioNode,
  type ScenarioRecordedFrom,
} from "../../cp/application/scenario/ScenarioTypes";
import { cannedResponse } from "../../cp/application/engine/responseValidation";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import type { WireFrame, WireVersion } from "../goldenWire/FakeCsms";
import { runBehavior } from "./runBehavior";

export interface RecordBehaviorOptions {
  /** A code behavior to load, or the id of a built-in `default.*` behavior. */
  readonly behavior: Behavior | string;
  readonly version: WireVersion;
  /** The CSMS CALL that triggers the behavior. */
  readonly trigger: { readonly action: string; readonly payload: unknown };
  /** Params the selection gives the behavior. */
  readonly params?: JsonObject;
  /** Same seed, same recording. Default `"record"`. */
  readonly seed?: string | number;
  /** How far the virtual clock runs after the CALL; default 600 000 ms. */
  readonly horizonMs?: number;
  /** Length of one clock step, the resolution of the delays; default 250 ms. */
  readonly stepMs?: number;
  /** The build that recorded it; default `"unknown"`. */
  readonly commit?: string;
  /** The simulator version that recorded it; default `"unknown"`. */
  readonly simulatorVersion?: string;
  /** Run before the trigger (configuration keys, connector state). */
  readonly prepare?: (cp: ChargePoint) => void;
}

export interface BehaviorRecording {
  readonly scenario: ScenarioDefinition;
  /** Mermaid `sequenceDiagram` source of the recorded exchange. */
  readonly diagram: string;
  /** What the run did that no node expresses; each line says why. */
  readonly skipped: readonly string[];
}

/** Station-initiated CALLs that are the station's own upkeep, not the behavior's. */
const BACKGROUND = new Set(["Heartbeat"]);

/** The notification actions the `notify` node stands for, by node kind. */
const NOTIFY_KINDS: Readonly<Record<string, string>> = {
  FirmwareStatusNotification: "firmwareStatus",
  SignedFirmwareStatusNotification: "signedFirmwareStatus",
  LogStatusNotification: "logStatus",
  DiagnosticsStatusNotification: "diagnosticsStatus",
};

interface Stamped {
  readonly frame: WireFrame;
  readonly at: number;
}

const FIXED_DATE = "2030-01-01T00:00:00.000Z";

export async function recordBehavior(
  options: RecordBehaviorOptions,
): Promise<BehaviorRecording> {
  const seed = options.seed ?? "record";
  const behaviorId =
    typeof options.behavior === "string"
      ? options.behavior
      : options.behavior.id;
  const run = await runBehavior({
    version: options.version,
    seed,
    ...(options.prepare ? { beforeConnect: options.prepare } : {}),
  });
  try {
    if (typeof options.behavior === "string") {
      run.cp.engine.activateBehavior(
        options.behavior,
        {
          kind: "scenario",
          scenarioId: "record",
          connectorId: 1,
          nodeId: "record",
        },
        options.params,
      );
    } else {
      run.cp.loadBehavior(
        options.behavior,
        options.params ? { params: options.params } : undefined,
      );
    }
    await run.settle();

    const stamped: Stamped[] = [];
    const origin = run.clock.now();
    run.csms.onFrame = (frame) =>
      stamped.push({ frame, at: run.clock.now() - origin });
    const callId = run.callNoWait(
      options.trigger.action,
      options.trigger.payload,
    );
    await run.settle();
    const horizon = options.horizonMs ?? 600_000;
    const step = options.stepMs ?? 250;
    await run.advanceInSteps(horizon, step);
    run.csms.onFrame = null;

    return build({
      options,
      behaviorId,
      seed,
      callId,
      stamped,
      canned: (action, kind) => {
        try {
          return cannedResponse(action, run.cp.ocppVersion, kind);
        } catch {
          return undefined;
        }
      },
    });
  } finally {
    run.csms.onFrame = null;
    await run.dispose();
  }
}

interface BuildInput {
  readonly options: RecordBehaviorOptions;
  readonly behaviorId: string;
  readonly seed: string | number;
  readonly callId: string;
  readonly stamped: readonly Stamped[];
  readonly canned: (
    action: string,
    kind: "accepted" | "rejected",
  ) => unknown | undefined;
}

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

function build(input: BuildInput): BehaviorRecording {
  const { options, callId } = input;
  const trigger = options.trigger;
  const skipped: string[] = [];
  const steps: Array<{
    type: string;
    label: string;
    data: Record<string, unknown>;
  }> = [];
  // The lines of the diagram, in order.
  const lines: string[] = [];
  const say = (from: "CSMS" | "CP", to: "CSMS" | "CP", text: string): void => {
    lines.push(`  ${from}->>${to}: ${text}`);
  };

  steps.push({
    type: "csmsCallTrigger",
    label: `Wait for ${trigger.action}`,
    data: { action: trigger.action, behavior: "replace" },
  });
  say("CSMS", "CP", trigger.action);

  let answered = false;
  let last = 0;
  const requestId =
    typeof (trigger.payload as { requestId?: unknown } | null)?.requestId ===
    "number"
      ? (trigger.payload as { requestId: number }).requestId
      : undefined;

  for (const { frame, at } of input.stamped) {
    if (frame.dir === "CP>" && frame.id === callId && frame.kind === "result") {
      answered = true;
      const accepted = input.canned(trigger.action, "accepted");
      const rejected = input.canned(trigger.action, "rejected");
      const kind =
        accepted !== undefined && sameJson(frame.payload, accepted)
          ? "accepted"
          : rejected !== undefined && sameJson(frame.payload, rejected)
            ? "rejected"
            : "result";
      steps.push({
        type: "callResponse",
        label: `Answer ${trigger.action}`,
        data: kind === "result" ? { kind, payload: frame.payload } : { kind },
      });
      say(
        "CP",
        "CSMS",
        `${trigger.action}.conf ${JSON.stringify(frame.payload)}`,
      );
      last = at;
      continue;
    }
    if (frame.dir === "CP>" && frame.id === callId && frame.kind === "error") {
      answered = true;
      const e = frame.payload as {
        errorCode?: string;
        errorDescription?: string;
      };
      steps.push({
        type: "callResponse",
        label: `Answer ${trigger.action} with an error`,
        data: {
          kind: "error",
          errorCode: e.errorCode ?? "GenericError",
          errorDescription: e.errorDescription ?? "",
        },
      });
      say("CP", "CSMS", `${trigger.action} error ${e.errorCode ?? ""}`);
      last = at;
      continue;
    }
    if (frame.dir !== "CP>" || frame.kind !== "call" || !frame.action) continue;
    if (BACKGROUND.has(frame.action)) {
      skipped.push(
        `${frame.action} at ${at} ms: station upkeep, not an effect of the behavior`,
      );
      continue;
    }
    if (!answered) {
      // A CALL before the answer is not a follow-up; a scenario cannot send it
      // while the CALL is held either, so it is listed, not invented.
      skipped.push(
        `${frame.action} at ${at} ms: sent before the answer settled`,
      );
      continue;
    }
    if (at > last) {
      const seconds = (at - last) / 1000;
      steps.push({
        type: "delay",
        label: `Wait ${seconds} s`,
        data: { delaySeconds: seconds },
      });
      lines.push(`  Note over CP: ${seconds} s`);
      last = at;
    }
    const payload = frame.payload as Record<string, unknown>;
    const notifyKind = NOTIFY_KINDS[frame.action];
    const status = payload?.status;
    if (notifyKind && typeof status === "string") {
      const rest = Object.keys(payload).filter(
        (key) => key !== "status" && key !== "requestId",
      );
      if (rest.length === 0) {
        const data: Record<string, unknown> = { kind: notifyKind, status };
        if (typeof payload.requestId === "number") {
          data.requestId =
            payload.requestId === requestId
              ? { $from: "call.payload.requestId" }
              : payload.requestId;
        }
        steps.push({
          type: "notify",
          label: `${frame.action} ${status}`,
          data,
        });
        say("CP", "CSMS", `${frame.action} ${status}`);
        continue;
      }
    }
    steps.push({
      type: "ocppCall",
      label: frame.action,
      data: { action: frame.action, payload },
    });
    say("CP", "CSMS", frame.action);
  }
  if (!answered) {
    steps.push({
      type: "callResponse",
      label: `No answer to ${trigger.action}`,
      data: { kind: "none" },
    });
    skipped.push(`${trigger.action}: the behavior sent no answer`);
  }

  const recordedFrom: ScenarioRecordedFrom = {
    behaviorId: input.behaviorId,
    commit: options.commit ?? "unknown",
    seed: input.seed,
    version: options.simulatorVersion ?? "unknown",
  };
  const id = `recorded-${input.behaviorId.replace(/[^A-Za-z0-9]+/g, "-")}-${trigger.action}`;
  const nodes: ScenarioNode[] = [
    node("start", "start", "Start", {}),
    ...steps.map((step, i) =>
      node(`n${i + 1}`, step.type, step.label, step.data),
    ),
    node("end", "end", "End", {}),
  ];
  const ids = nodes.map((n) => n.id);
  const edges: Edge[] = ids.slice(1).map((target, i) => ({
    id: `e${i + 1}`,
    source: ids[i] as string,
    target,
  }));
  const scenario: ScenarioDefinition = {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id,
    recordedFrom,
    name: `Recording of ${input.behaviorId} (${trigger.action})`,
    description:
      `Recorded from ${input.behaviorId} with seed ${String(input.seed)}. ` +
      "A trace of one run, not the behavior itself.",
    targetType: "chargePoint",
    nodes,
    edges,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
  };
  const diagram = [
    "sequenceDiagram",
    "  participant CSMS",
    "  participant CP as Charge point",
    ...lines,
  ].join("\n");
  return { scenario, diagram, skipped };
}

function node(
  id: string,
  type: string,
  label: string,
  data: Record<string, unknown>,
): ScenarioNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label, ...data },
  } as unknown as ScenarioNode;
}
