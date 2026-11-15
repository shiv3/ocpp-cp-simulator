import type {
  ChoiceNodeData,
  NotifyNodeData,
  SetStateNodeData,
  SwitchNodeData,
} from "../ScenarioTypes";
import { NOTIFY_KINDS } from "../ScenarioTypes";
import {
  isFromReference,
  resolveFrom,
  resolveFromOrMissing,
} from "../resolveFrom";
import {
  DIAGNOSTICS_STATUSES,
  FIRMWARE_STATUSES,
  UPLOAD_LOG_STATUSES,
} from "@ocpp-cp-simulator/contracts/firmwareLogStatus";
import { jsonProblem } from "../../behavior/paramsSchema";
import {
  MISSING,
  matchCase,
  matcherProblem,
} from "../../../../scenario/valueMatch";
import type { Flow, NodeRunContext } from "./context";

const STATE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Schema 1.6 (#654): `ctx.notify` as a node; does not wait for the CSMS. */
export function executeNotify(
  ctx: NodeRunContext,
  data: NotifyNodeData,
  flow: Flow,
): void {
  if (!ctx.callbacks.onNotify) {
    throw new Error("notify: this station cannot send notifications");
  }
  if (!(NOTIFY_KINDS as readonly string[]).includes(data.kind)) {
    throw new Error(
      `notify: kind must be one of ${NOTIFY_KINDS.join(", ")}, got ${JSON.stringify(data.kind)}`,
    );
  }
  const statuses: readonly string[] =
    data.kind === "logStatus"
      ? UPLOAD_LOG_STATUSES
      : data.kind === "diagnosticsStatus"
        ? DIAGNOSTICS_STATUSES
        : FIRMWARE_STATUSES;
  if (typeof data.status !== "string" || !statuses.includes(data.status)) {
    throw new Error(
      `notify: status for ${data.kind} must be one of ${statuses.join(", ")}, got ${JSON.stringify(data.status)}`,
    );
  }
  let requestId: number | undefined;
  if (data.requestId !== undefined) {
    const resolved = resolveFrom(
      data.requestId,
      ctx.fromScope(flow),
      `notify(${data.kind})`,
    );
    if (
      typeof resolved !== "number" ||
      !Number.isInteger(resolved) ||
      resolved < 0
    ) {
      throw new Error(
        `notify: requestId must be a whole number of at least 0, got ${JSON.stringify(resolved)}`,
      );
    }
    requestId = resolved;
  }
  if (data.kind === "signedFirmwareStatus" && requestId === undefined) {
    throw new Error("notify: signedFirmwareStatus needs a requestId");
  }
  ctx.callbacks.onNotify(data.kind, data.status, requestId);
  ctx.callbacks.log?.(
    `Notified ${data.kind} ${data.status}` +
      (requestId === undefined ? "" : ` (requestId ${requestId})`),
    "info",
  );
}

/** Schema 1.6 (#654): go on along `case-<n>` of the first equal case, else `default`. */
export function executeSwitch(
  ctx: NodeRunContext,
  data: SwitchNodeData,
  flow: Flow,
): void {
  const { index, value } = pickCase(
    ctx,
    "switch",
    data.value,
    data.cases,
    flow,
  );
  flow.handle = index >= 0 ? `case-${index}` : "default";
  ctx.callbacks.log?.(
    `Switch on ${value === MISSING ? "(missing)" : JSON.stringify(value)} → ${flow.handle}`,
    "info",
  );
}

/**
 * The case a value picks, for a switch and for the `until` of a loop edge
 * (schema 1.10): the index of the first case that matches (a JSON constant
 * by equality, `{ "$match": … }` by its operators), or -1. `valueSpec` is
 * resolved against this branch (`$from`); a missing value matches only an
 * `exists: false` case, else the run fails with the usual error. Throws, with
 * `label` as prefix, on malformed cases. Returns the resolved value too.
 */
export function pickCase(
  ctx: NodeRunContext,
  label: string,
  valueSpec: unknown,
  cases: unknown,
  flow: Flow,
): { index: number; value: unknown } {
  if (!Array.isArray(cases)) {
    throw new Error(`${label}: cases must be an array`);
  }
  cases.forEach((value: unknown, index: number) => {
    const bad = jsonProblem(value, `cases[${index}]`);
    if (bad || isFromReference(value)) {
      throw new Error(
        `${label}: cases are JSON constants${bad ? ` (${bad})` : ', a "$from" is not allowed'}`,
      );
    }
    const problem = matcherProblem(value);
    if (problem) {
      throw new Error(`${label}: cases[${index}]: ${problem.message}`);
    }
  });
  const scope = ctx.fromScope(flow);
  const value = resolveFromOrMissing(valueSpec, scope, label);
  const index = cases.findIndex((candidate: unknown) =>
    matchCase(value, candidate),
  );
  if (value === MISSING && index < 0) {
    // No `exists: false` case: fail as before, with the usual message.
    resolveFrom(valueSpec, scope, label);
  }
  return { index, value };
}

/** Schema 1.6 (#654): a seeded, weighted draw; go on along `option-<n>`. */
export function executeChoice(
  ctx: NodeRunContext,
  data: ChoiceNodeData,
  flow: Flow,
): void {
  const options = data.options;
  if (!Array.isArray(options) || options.length < 2) {
    throw new Error("choice: options must list at least two options");
  }
  const weights = options.map((option, index) => {
    const weight = option?.weight ?? 1;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
      throw new Error(
        `choice: options[${index}].weight must be a number above 0, got ${JSON.stringify(weight)}`,
      );
    }
    return weight;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const draw = ctx.rng.next() * total;
  let acc = 0;
  let picked = weights.length - 1;
  for (let i = 0; i < weights.length; i += 1) {
    acc += weights[i]!;
    if (draw < acc) {
      picked = i;
      break;
    }
  }
  flow.handle = `option-${picked}`;
  ctx.callbacks.log?.(
    `Choice → ${flow.handle}${options[picked]?.label ? ` (${options[picked]!.label})` : ""}`,
    "info",
  );
}

/** Schema 1.6 (#654): store a JSON value in the state of this run. */
export function executeSetState(
  ctx: NodeRunContext,
  data: SetStateNodeData,
  flow: Flow,
): void {
  if (typeof data.key !== "string" || !STATE_KEY.test(data.key)) {
    throw new Error(
      `setState: key must be letters, digits and underscores, not starting with a digit, got ${JSON.stringify(data.key)}`,
    );
  }
  const value = resolveFrom(
    data.value,
    ctx.fromScope(flow),
    `setState(${data.key})`,
  );
  const bad = jsonProblem(value, "value");
  if (bad || value === undefined) {
    throw new Error(`setState: value must be JSON${bad ? ` (${bad})` : ""}`);
  }
  ctx.runState[data.key] = value;
  ctx.callbacks.log?.(`State ${data.key} = ${JSON.stringify(value)}`, "info");
}
