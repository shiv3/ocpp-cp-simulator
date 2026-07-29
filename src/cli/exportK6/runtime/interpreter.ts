// src/cli/exportK6/runtime/interpreter.ts
// Executes a ScenarioDefinition's node/edge graph against a ScenarioHost.
// Semantics mirror src/cp/application/scenario/ScenarioExecutor.ts, reduced
// to what a load-test CP needs (no pause/step/resume, no persistence).
import {
  bool,
  num,
  str,
  type ScenarioJson,
  type ScenarioNodeJson,
  type Wire,
  type WireCall,
} from "./types";

export interface ScenarioHost {
  readonly connectorId: number;
  call(c: WireCall): Promise<Record<string, unknown>>;
  waitForCsmsCall(
    actions: readonly string[],
    timeoutMs: number | null,
  ): Promise<{ action: string; payload: Record<string, unknown> }>;
  sleep(ms: number): Promise<void>;
  nowIso(): string;
  getLocalStatus(): string;
  setLocalStatus(status: string): void;
  waitForLocalStatus(target: string, timeoutMs: number | null): Promise<void>;
  armResponseOverride(action: string, status: string): void;
  setUnlockOutcome(outcome: string): void;
  setLocalConfig(key: string, value: string): void;
}

export interface RunResult {
  completed: boolean;
  steps: number;
  error?: string;
}

interface RunContext {
  transactionId: number | null;
  meterWh: number;
  lastRemoteTagId: string | null;
  steps: number;
  maxSteps: number;
  stopAutoMeter: (() => void) | null;
  background: Promise<void>[];
}

export async function runScenario(
  host: ScenarioHost,
  wire: Wire,
  scenario: ScenarioJson,
  opts: { maxSteps?: number } = {},
): Promise<RunResult> {
  const ctx: RunContext = {
    transactionId: null,
    meterWh: 0,
    lastRemoteTagId: null,
    steps: 0,
    maxSteps: opts.maxSteps ?? 10_000,
    stopAutoMeter: null,
    background: [],
  };
  const byId = new Map(scenario.nodes.map((n) => [n.id, n]));
  const start = scenario.nodes.find((n) => n.type === "start");
  if (!start)
    return { completed: false, steps: 0, error: "scenario has no start node" };
  try {
    await walkFrom(start, scenario, byId, host, wire, ctx);
    return { completed: true, steps: ctx.steps };
  } catch (err) {
    return {
      completed: false,
      steps: ctx.steps,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    ctx.stopAutoMeter?.();
    await Promise.all(ctx.background.map((p) => p.catch(() => {})));
  }
}

async function walkFrom(
  node: ScenarioNodeJson,
  scenario: ScenarioJson,
  byId: Map<string, ScenarioNodeJson>,
  host: ScenarioHost,
  wire: Wire,
  ctx: RunContext,
): Promise<void> {
  let current: ScenarioNodeJson | undefined = node;
  while (current) {
    if (current.type !== "start") {
      if (++ctx.steps > ctx.maxSteps) {
        throw new Error(
          `scenario exceeded ${ctx.maxSteps} steps (edge cycle?)`,
        );
      }
      await executeNode(current, host, wire, ctx, scenario);
    }
    if (current.type === "end") return;
    const currentId = current.id;
    // Explicit annotation avoids a TS7022 circular-inference false positive that
    // otherwise fires here (recursive fn + loop-reassigned `let` + chained
    // filter/map/filter type guard); confirmed via a minimal repro against this
    // repo's tsconfig.cli.json (bun-types) — no functional effect.
    const next: ScenarioNodeJson[] = scenario.edges
      .filter((e) => e.source === currentId)
      .map((e) => byId.get(e.target))
      .filter((n): n is ScenarioNodeJson => n !== undefined);
    if (next.length === 0) return;
    if (next.length === 1) {
      current = next[0];
      continue;
    }
    await Promise.all(
      next.map((n) => walkFrom(n, scenario, byId, host, wire, ctx)),
    );
    return;
  }
}

/** Mirrors frames.ts's asRecord: only non-null, non-array objects pass through
 * as a payload — a string/number/array would otherwise reach host.call and
 * produce a frame the CSMS rejects. */
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

async function executeNode(
  node: ScenarioNodeJson,
  host: ScenarioHost,
  wire: Wire,
  ctx: RunContext,
  scenario: ScenarioJson,
): Promise<void> {
  const d = node.data;
  const timeoutMs = (): number | null => {
    const t = num(d.timeout);
    return t === undefined || t === 0 ? null : t * 1000;
  };
  const notifyStatus = async (status: string): Promise<void> => {
    host.setLocalStatus(status);
    await host.call(wire.statusNotification(host.connectorId, status));
  };

  switch (node.type) {
    case "end":
      return;
    case "statusChange":
      await notifyStatus(str(d.status) ?? "Available");
      return;
    case "transaction": {
      if (d.action === "start") {
        const tagId = str(d.tagId) ?? ctx.lastRemoteTagId ?? "K6-TAG";
        const conf = await host.call(
          wire.startTransaction(
            host.connectorId,
            tagId,
            ctx.meterWh,
            host.nowIso(),
          ),
        );
        const parsed = wire.parseStartTransactionConf(conf);
        if (!parsed.accepted) {
          throw new Error(`StartTransaction not accepted for idTag ${tagId}`);
        }
        ctx.transactionId = parsed.transactionId;
        await notifyStatus("Charging");
        return;
      }
      if (ctx.transactionId === null) {
        throw new Error("transaction stop without an active transaction");
      }
      await host.call(
        wire.stopTransaction(
          ctx.transactionId,
          ctx.meterWh,
          host.nowIso(),
          str(d.stopReason),
        ),
      );
      ctx.transactionId = null;
      await notifyStatus("Finishing");
      return;
    }
    case "meterValue": {
      ctx.meterWh = num(d.value) ?? ctx.meterWh;
      if (bool(d.sendMessage)) {
        await host.call(
          wire.meterValues(
            host.connectorId,
            ctx.transactionId,
            ctx.meterWh,
            host.nowIso(),
          ),
        );
      }
      if (bool(d.autoIncrement)) startAutoMeter(d, host, wire, ctx, scenario);
      return;
    }
    case "delay":
      await host.sleep((num(d.delaySeconds) ?? 0) * 1000);
      return;
    case "notification":
      await host.call({
        action: str(d.messageType) ?? "DataTransfer",
        payload: asRecord(d.payload),
      });
      return;
    case "connectorPlug":
      await notifyStatus(d.action === "plugout" ? "Available" : "Preparing");
      return;
    case "remoteStartTrigger": {
      const evt = await host.waitForCsmsCall(
        wire.triggerActions("remoteStart"),
        timeoutMs(),
      );
      ctx.lastRemoteTagId = wire.remoteStartTagId(evt.payload);
      return;
    }
    case "remoteStopTrigger":
      await host.waitForCsmsCall(
        wire.triggerActions("remoteStop"),
        timeoutMs(),
      );
      return;
    case "statusTrigger":
      await host.waitForLocalStatus(
        str(d.targetStatus) ?? "Available",
        timeoutMs(),
      );
      return;
    case "csmsCallTrigger": {
      const action = str(d.action);
      if (!action)
        throw new Error(`csmsCallTrigger node ${node.id} has no action`);
      await host.waitForCsmsCall([action], timeoutMs());
      return;
    }
    case "reserveNow":
      await notifyStatus("Reserved");
      return;
    case "cancelReservation":
      await notifyStatus("Available");
      return;
    case "reservationTrigger":
      await host.waitForCsmsCall(
        wire.triggerActions("reserveNow"),
        timeoutMs(),
      );
      return;
    case "statusNotification": {
      const status = str(d.status) ?? "Available";
      host.setLocalStatus(status);
      await host.call(
        wire.statusNotification(
          num(d.connectorId) ?? host.connectorId,
          status,
          {
            errorCode: str(d.errorCode),
            info: str(d.info),
            vendorErrorCode: str(d.vendorErrorCode),
            vendorId: str(d.vendorId),
          },
        ),
      );
      return;
    }
    case "unlockOutcome":
      host.setUnlockOutcome(str(d.outcome) ?? "Unlocked");
      return;
    case "configSet":
      host.setLocalConfig(str(d.key) ?? "", str(d.value) ?? "");
      return;
    case "dataTransfer":
      await host.call(
        wire.dataTransfer(
          str(d.vendorId) ?? "unknown",
          str(d.messageId),
          str(d.data),
        ),
      );
      return;
    case "responseOverride": {
      const action = str(d.action);
      const status = str(d.status);
      if (action && status) host.armResponseOverride(action, status);
      return;
    }
    default:
      throw new Error(`unsupported node type "${node.type}" (node ${node.id})`);
  }
}

interface CurvePointJson {
  time: number;
  value: number; // kWh, absolute meter value
}

function startAutoMeter(
  d: Record<string, unknown>,
  host: ScenarioHost,
  wire: Wire,
  ctx: RunContext,
  scenario: ScenarioJson,
): void {
  ctx.stopAutoMeter?.();
  let stopped = false;
  ctx.stopAutoMeter = () => {
    stopped = true;
  };
  const intervalSec = num(d.incrementInterval) ?? 10;
  const ev = {
    capacityKwh: scenario.evSettings?.batteryCapacityKwh ?? 40,
    initialSoc: scenario.evSettings?.initialSoc ?? 20,
    targetSoc: scenario.evSettings?.targetSoc ?? 80,
  };
  const outputKw =
    num(d.outputKw) ?? scenario.evSettings?.maxChargingPowerKw ?? 50;
  const incrementWh =
    num(d.incrementAmount) ??
    Math.round((outputKw * 1000 * intervalSec) / 3600);
  const curve = bool(d.useCurve)
    ? ((d.curvePoints as CurvePointJson[] | undefined) ?? [])
    : null;
  const startWh = ctx.meterWh;
  const send = bool(d.sendMessage) ?? false;

  const task = (async () => {
    let elapsedSec = 0;
    for (;;) {
      await host.sleep(intervalSec * 1000);
      if (stopped) return;
      elapsedSec += intervalSec;
      if (curve && curve.length > 0) {
        ctx.meterWh = Math.round(interpolateCurveKwh(curve, elapsedSec) * 1000);
      } else {
        ctx.meterWh += incrementWh;
      }
      if (send) {
        await host.call(
          wire.meterValues(
            host.connectorId,
            ctx.transactionId,
            ctx.meterWh,
            host.nowIso(),
          ),
        );
      }
      if (shouldStop(d, ev, ctx.meterWh, startWh, elapsedSec, curve)) return;
    }
  })().catch(() => {
    // Auto-meter failures must not crash the walk; the CALLERROR is already
    // recorded in the transcript by the host.
  });
  ctx.background.push(task);
}

function shouldStop(
  d: Record<string, unknown>,
  ev: { capacityKwh: number; initialSoc: number; targetSoc: number },
  meterWh: number,
  startWh: number,
  elapsedSec: number,
  curve: CurvePointJson[] | null,
): boolean {
  if (curve && curve.length > 0) {
    return elapsedSec >= curve[curve.length - 1].time;
  }
  if (d.stopMode === "evSettings") {
    const chargedKwh = (meterWh - startWh) / 1000;
    const soc = ev.initialSoc + (chargedKwh / ev.capacityKwh) * 100;
    return soc >= ev.targetSoc;
  }
  const maxTime = num(d.maxTime) ?? 0;
  const maxValue = num(d.maxValue) ?? 0;
  if (maxTime > 0 && elapsedSec >= maxTime) return true;
  if (maxValue > 0 && meterWh >= maxValue) return true;
  return false;
}

function interpolateCurveKwh(curve: CurvePointJson[], atSec: number): number {
  const sorted = [...curve].sort((a, b) => a.time - b.time);
  if (atSec <= sorted[0].time) return sorted[0].value;
  for (let i = 1; i < sorted.length; i++) {
    if (atSec <= sorted[i].time) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const f = b.time === a.time ? 1 : (atSec - a.time) / (b.time - a.time);
      return a.value + (b.value - a.value) * f;
    }
  }
  return sorted[sorted.length - 1].value;
}
