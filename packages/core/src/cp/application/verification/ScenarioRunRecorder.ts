import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { Connector } from "../../domain/connector/Connector";
import { LogType } from "../../shared/Logger";
import type { ScenarioRunRepository } from "./ScenarioRunRepository";
import { clockOf } from "../../shared/clock";
import { rngOf } from "../../shared/rng";
import type {
  ScenarioDefinition,
  ScenarioWaitIntervention,
} from "../scenario/ScenarioTypes";
import {
  computeVerdictSummary,
  evaluateAssertions,
  frameToTranscriptEntry,
  redactTranscriptEntry,
  type ScenarioRunResult,
  type ScenarioStateSnapshot,
} from "./ScenarioAssertions";
import { TranscriptBuffer } from "./TranscriptBuffer";

/**
 * #394: builds and records the report of every scenario run of one charge
 * point — transcript capture, assertion evaluation, the verdict and the
 * {@link ScenarioRunResult} — for both runtimes: the daemon's
 * `CLIChargePointService` and the browser's `ScenarioManager`. One place, so
 * a Local run and a daemon run of the same scenario produce the same report.
 *
 * Bookkeeping is per scenario id (one run of a scenario at a time, as in both
 * runtimes). {@link begin} opens a run, {@link finalize} closes it exactly
 * once; a second call for the same run is a no-op, so a stop path and the
 * executor's own `finally` can both call it.
 */

export interface ScenarioRunRecorderDeps {
  readonly chargePoint: ChargePoint;
  readonly runs: ScenarioRunRepository;
  /** The simulator version stamped on each report. */
  readonly simulatorVersion: () => string;
  /** The OCPP version stamped on each report. */
  readonly ocppVersion: () => string;
  /** Called after a report was stored (never when the write failed). */
  readonly onRecorded?: (result: ScenarioRunResult) => void;
  /** Epoch ms; defaults to the charge point's clock. */
  readonly now?: () => number;
}

export interface ScenarioRunFinish {
  readonly scenarioId: string;
  readonly connectorId: number;
  readonly runId: string;
  /** The definition as it is installed now (for name, assertions, strict). */
  readonly definition: ScenarioDefinition | undefined;
  readonly executionState: "completed" | "error";
  readonly blocked: boolean;
  readonly errors: string[];
  readonly timeout: { nodeId: string; expectation?: unknown } | null;
  readonly stopped?: boolean;
}

/** A stable, human-legible run id: `scenarioId#<epochMs>-<rand>`. */
export function makeScenarioRunId(
  scenarioId: string,
  epochMs: number,
  random: number,
): string {
  return `${scenarioId}#${epochMs}-${random.toString(36).slice(2, 6)}`;
}

/** The observable state of a connector for a report's initial / final state. */
export function connectorStateSnapshot(
  connector: Connector,
): ScenarioStateSnapshot {
  return {
    connectorStatus: connector.status,
    meterValue: connector.meterValue,
    transactionId: connector.transaction?.id ?? null,
  };
}

/** Open runs are per connector: Local runs one scenario manager per connector,
 *  so the same scenario id can be running on two connectors at once. */
function openKey(connectorId: number, scenarioId: string): string {
  return `${connectorId}\u0000${scenarioId}`;
}

interface OpenRun {
  readonly transcript: TranscriptBuffer;
  readonly startedAt: string;
  readonly initialState: ScenarioStateSnapshot;
  readonly strict: boolean | undefined;
  readonly interventions: ScenarioWaitIntervention[];
}

export class ScenarioRunRecorder {
  private readonly open = new Map<string, OpenRun>();

  constructor(private readonly deps: ScenarioRunRecorderDeps) {}

  /** A fresh run id for `scenarioId`, from the charge point's clock and rng. */
  newRunId(scenarioId: string): string {
    const { chargePoint } = this.deps;
    return makeScenarioRunId(
      scenarioId,
      this.now(),
      rngOf(chargePoint, "scenario-run-id").next(),
    );
  }

  private now(): number {
    return (this.deps.now ?? (() => clockOf(this.deps.chargePoint).now()))();
  }

  /**
   * Open a run: start capturing the OCPP transcript and snapshot the
   * connector. Replaces any run of the same scenario that never finalized.
   */
  begin(
    scenarioId: string,
    connector: Connector,
    options?: { strict?: boolean },
  ): void {
    this.discard(scenarioId, connector.id);
    const transcript = new TranscriptBuffer(this.deps.chargePoint.logger);
    transcript.start();
    this.open.set(openKey(connector.id, scenarioId), {
      transcript,
      startedAt: new Date(this.now()).toISOString(),
      initialState: connectorStateSnapshot(connector),
      strict: options?.strict,
      interventions: [],
    });
  }

  isOpen(scenarioId: string, connectorId: number): boolean {
    return this.open.has(openKey(connectorId, scenarioId));
  }

  /** #240: an operator extended, retried or continued a parked wait. */
  recordIntervention(
    scenarioId: string,
    connectorId: number,
    intervention: ScenarioWaitIntervention,
  ): void {
    this.open
      .get(openKey(connectorId, scenarioId))
      ?.interventions.push(intervention);
  }

  /** Drop an open run without a report (scenario deleted or replaced). */
  discard(scenarioId: string, connectorId: number): void {
    const key = openKey(connectorId, scenarioId);
    const run = this.open.get(key);
    if (!run) return;
    run.transcript.stop();
    this.open.delete(key);
  }

  /** Stop every open capture; no report is written. */
  dispose(): void {
    for (const run of this.open.values()) run.transcript.stop();
    this.open.clear();
  }

  /**
   * Close the run: evaluate the declared assertions against the transcript,
   * compute the verdict and store the report. Returns the report, or `null`
   * when the run was not open (already finalized) or the write failed.
   */
  finalize(finish: ScenarioRunFinish): ScenarioRunResult | null {
    const { chargePoint } = this.deps;
    const { scenarioId, connectorId, runId, definition } = finish;
    chargePoint.timeline.endRun(connectorId, runId);
    const key = openKey(connectorId, scenarioId);
    const run = this.open.get(key);
    if (!run) return null;
    run.transcript.stop();
    this.open.delete(key);

    const endedAt = new Date(this.now()).toISOString();
    const { startedAt, initialState } = run;

    const assertions = evaluateAssertions(
      definition?.assertions ?? [],
      run.transcript.frames,
    );
    // Effective strict: per-run option, then the scenario definition, then off.
    const effectiveStrict =
      run.strict !== undefined
        ? run.strict
        : (definition?.strictCompatibility ?? false);
    const verdictSummary = computeVerdictSummary(assertions, {
      executionState: finish.executionState,
      blocked: finish.blocked,
      strict: effectiveStrict,
    });
    const stopped = finish.stopped ?? false;
    chargePoint.timeline.record({
      kind: "scenario_finished",
      connectorId,
      runId,
      summary: `Scenario ${scenarioId} ${stopped ? "stopped" : "finished"}: ${verdictSummary.verdict}`,
      data: {
        scenarioId,
        verdict: verdictSummary.verdict,
        executionState: finish.executionState,
        stopped,
      },
    });

    // Flatten + redact the captured transcript before it can reach a client
    // (payloads carry auth material -- redactTranscriptEntry).
    const transcript = run.transcript.frames.map((frame, i) =>
      redactTranscriptEntry(frameToTranscriptEntry(frame, i)),
    );
    const connector = chargePoint.connectors.get(connectorId);
    const finalState: ScenarioStateSnapshot = connector
      ? connectorStateSnapshot(connector)
      : initialState;

    const result: ScenarioRunResult = {
      schemaVersion: 1,
      runId,
      scenarioId,
      scenarioName: definition?.name,
      cpId: chargePoint.id,
      connectorId,
      simulatorVersion: this.deps.simulatorVersion(),
      ocppVersion: this.deps.ocppVersion(),
      startedAt,
      endedAt,
      durationMs: Math.max(
        0,
        new Date(endedAt).getTime() - new Date(startedAt).getTime(),
      ),
      executionState: finish.executionState,
      stopped,
      verdict: verdictSummary.verdict,
      conformanceVerdict: verdictSummary.conformanceVerdict,
      compatibilityVerdict: verdictSummary.compatibilityVerdict,
      strict: verdictSummary.strict,
      assertions,
      transcript,
      errors: finish.errors,
      timeout: finish.timeout,
      interventions: run.interventions,
      initialState,
      finalState,
    };
    return this.record(result) ? result : null;
  }

  /** Stores a run result in the run history (which applies retention), then
   *  announces it — after the write, so a client refreshing on the event
   *  reads the run. A failed write never fails the run: it already ended,
   *  only its report is lost, and is logged on the charge point. */
  private record(result: ScenarioRunResult): boolean {
    try {
      this.deps.runs.record(result);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.chargePoint.logger.error(
        `Scenario run ${result.runId} finished (${result.verdict}) but its report was not recorded: ${reason}`,
        LogType.SCENARIO,
      );
      return false;
    }
    this.deps.onRecorded?.(result);
    return true;
  }
}
