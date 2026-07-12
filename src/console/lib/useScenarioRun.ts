import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ScenarioDefinition,
  ScenarioExecutionMode,
} from "../../cp/application/scenario/ScenarioTypes";
import type { ChargePointEvent } from "../../data/interfaces/ChargePointService";
import { useDataContext } from "../../data/providers/DataProvider";

export type ScenarioRunState = "idle" | "running" | "completed" | "error";

export interface ScenarioRunHistoryEntry {
  startedAt: Date;
  endedAt: Date | null;
  result: "running" | "completed" | "stopped" | "error";
  failedNodeId?: string;
}

export interface UseScenarioRunResult {
  state: ScenarioRunState;
  /** nodeId of the most recent `scenario-node-execute` event. Kept even
   *  after the run ends (completed/stopped/error) so callers can tell which
   *  node was last active — see RunTimeline's status derivation. */
  currentNodeId: string | null;
  /** Accumulated, in order, deduped nodeIds seen via `scenario-node-execute`. */
  executedNodeIds: string[];
  error: string | null;
  /** `loadScenario` -> `runScenario`, mirroring the exact RPC sequence v2's
   *  server-side `runScenarioFile`/`runScenarioTemplate` helpers use
   *  (RegistryChargePointService.ts) and LocalChargePointService's
   *  browser-mode equivalent. `mode` is threaded into the loaded
   *  definition's `defaultExecutionMode` for forward-compatibility, but as
   *  of this writing nothing in the scenario runtime reads that field —
   *  `runScenario` itself takes no mode argument, so both modes issue the
   *  identical RPC calls. */
  start(mode?: ScenarioExecutionMode): Promise<void>;
  stop(): Promise<void>;
  /** `stepScenario` on the active runtime scenarioId. No-ops if no run is
   *  active. */
  step(): Promise<void>;
  /** Session-local, newest first. */
  runs: ScenarioRunHistoryEntry[];
}

/**
 * Drives a scenario run against the discovered v2 mechanism: `loadScenario`
 * (activates the definition into the runtime, returning its runtime
 * `scenarioId`) followed by `runScenario` (starts it). Progress is tracked
 * purely from the four scenario `ChargePointEvent` variants that actually
 * exist — `scenario-started` / `scenario-node-execute` / `scenario-completed`
 * / `scenario-error` — filtered to this connector + the scenarioId this hook
 * itself started. There is no `scenario-node-complete` or
 * `scenario-node-progress` event, so per-node fractional progress isn't
 * tracked (a node reads "done" once a later node-execute event or
 * `scenario-completed` arrives — see RunTimeline). There is also no
 * `pauseScenario`/`resumeScenario` on `ChargePointService` (only
 * `ScenarioManager`, an in-process-only class, exposes those) — remote mode
 * has no wire equivalent, so this hook and its page deliberately omit
 * pause/resume.
 */
export function useScenarioRun(
  cpId: string | null,
  connectorId: number | null,
  scenario: ScenarioDefinition | null,
): UseScenarioRunResult {
  const { chargePointService } = useDataContext();

  const [state, setState] = useState<ScenarioRunState>("idle");
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [executedNodeIds, setExecutedNodeIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScenarioRunHistoryEntry[]>([]);

  // Refs mirror the corresponding state so the event handler (registered
  // once per cpId/connectorId, not re-registered on every event) always
  // reads the latest value instead of a stale closure.
  const activeScenarioIdRef = useRef<string | null>(null);
  const currentNodeIdRef = useRef<string | null>(null);

  // Reset everything when the viewed target changes.
  useEffect(() => {
    setState("idle");
    setCurrentNodeId(null);
    setExecutedNodeIds([]);
    setError(null);
    setRuns([]);
    activeScenarioIdRef.current = null;
    currentNodeIdRef.current = null;
  }, [cpId, connectorId, scenario?.id]);

  const closeActiveRun = useCallback(
    (result: "completed" | "stopped" | "error", failedNodeId?: string) => {
      setRuns((prev) => {
        if (prev.length === 0) return prev;
        const [head, ...rest] = prev;
        if (head.endedAt) return prev; // already closed
        return [
          { ...head, endedAt: new Date(), result, failedNodeId },
          ...rest,
        ];
      });
    },
    [],
  );

  useEffect(() => {
    if (!cpId) return undefined;

    const unsubscribe = chargePointService.subscribe(
      cpId,
      (event: ChargePointEvent) => {
        if (!("scenarioId" in event) || !("connectorId" in event)) return;
        if (event.scenarioId !== activeScenarioIdRef.current) return;
        if (connectorId != null && event.connectorId !== connectorId) return;

        switch (event.type) {
          case "scenario-started":
            setState("running");
            break;
          case "scenario-node-execute":
            currentNodeIdRef.current = event.nodeId;
            setCurrentNodeId(event.nodeId);
            setExecutedNodeIds((prev) =>
              prev.includes(event.nodeId) ? prev : [...prev, event.nodeId],
            );
            break;
          case "scenario-completed":
            setState("completed");
            closeActiveRun("completed");
            break;
          case "scenario-error":
            setError(event.error);
            setState("error");
            closeActiveRun("error", currentNodeIdRef.current ?? undefined);
            break;
          default:
            break;
        }
      },
    );

    return unsubscribe;
  }, [cpId, connectorId, chargePointService, closeActiveRun]);

  const start = useCallback(
    async (mode?: ScenarioExecutionMode) => {
      if (!cpId || connectorId == null || !scenario) return;

      setError(null);
      const definitionToLoad = mode
        ? { ...scenario, defaultExecutionMode: mode }
        : scenario;

      // Push the run-history entry BEFORE the RPCs (not after `loadScenario`
      // resolves) so a rejection from either `loadScenario` or `runScenario`
      // still has a "running" entry to close as "error" below. Pushing it
      // only on the success path meant a failed attempt left `runs` empty —
      // `closeActiveRun` no-ops on an empty array — so RunHistory silently
      // showed "No runs yet this session" despite a real failed attempt.
      setRuns((prev) => [
        { startedAt: new Date(), endedAt: null, result: "running" },
        ...prev,
      ]);

      try {
        const { scenarioId } = await chargePointService.loadScenario(
          cpId,
          connectorId,
          definitionToLoad,
        );
        activeScenarioIdRef.current = scenarioId;
        currentNodeIdRef.current = null;
        setCurrentNodeId(null);
        setExecutedNodeIds([]);
        setState("running");

        await chargePointService.runScenario(cpId, connectorId, scenarioId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setState("error");
        closeActiveRun("error", currentNodeIdRef.current ?? undefined);
      }
    },
    [cpId, connectorId, scenario, chargePointService, closeActiveRun],
  );

  const stop = useCallback(async () => {
    const scenarioId = activeScenarioIdRef.current;
    if (!cpId || connectorId == null || !scenarioId) return;

    try {
      await chargePointService.stopScenario(cpId, connectorId, scenarioId);
    } catch (err) {
      // `stopScenario` rejected: the runtime never confirmed the stop, so
      // the scenario may well still be running there. Reporting "idle" here
      // (the old `finally`-only behavior) would silently swallow the RPC
      // failure and, worse, leave later `scenario-node-execute` events for
      // this scenarioId still updating `currentNodeId`/`executedNodeIds`
      // behind an "Idle" badge the user has no reason to distrust. Instead
      // surface "error" and close the run as "error" (not "stopped") so
      // both the badge and run history tell the truth. Deliberately leave
      // `activeScenarioIdRef` set (unlike the success path below) so the
      // event filter keeps accepting events for this scenarioId — the run
      // is still live from the runtime's point of view, and later events
      // (e.g. a `scenario-completed` that arrives despite the failed stop)
      // should keep updating this hook's state rather than being dropped.
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setState("error");
      closeActiveRun("error", currentNodeIdRef.current ?? undefined);
      return;
    }

    // Stop confirmed by the runtime: this scenarioId is done, so clear the
    // ref too — no legitimate further events for it should arrive, and
    // doing so keeps `step()`/a second `stop()` from acting on a stale id.
    activeScenarioIdRef.current = null;
    setState("idle");
    closeActiveRun("stopped");
  }, [cpId, connectorId, chargePointService, closeActiveRun]);

  const step = useCallback(async () => {
    const scenarioId = activeScenarioIdRef.current;
    if (!cpId || connectorId == null || !scenarioId) return;
    await chargePointService.stepScenario(cpId, connectorId, scenarioId);
  }, [cpId, connectorId, chargePointService]);

  return {
    state,
    currentNodeId,
    executedNodeIds,
    error,
    start,
    stop,
    step,
    runs,
  };
}
