import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
  ScenarioExecutionMode,
  ScenarioExpectation,
} from "../../cp/application/scenario/ScenarioTypes";
import type { ChargePointEvent } from "../../data/interfaces/ChargePointService";
import { useDataContext } from "../../data/providers/DataProvider";

/** The runtime's live execution states — the same set
 *  `useActiveScenarioRuns` lists as "active". */
const LIVE_RUN_STATES = ["running", "paused", "stepping", "waiting"] as const;
type LiveRunState = (typeof LIVE_RUN_STATES)[number];

export type ScenarioRunState = "idle" | LiveRunState | "completed" | "error";

/** True while a run is in flight (executing, parked waiting, paused or
 *  stepping) — i.e. there is something to Stop. */
export function isLiveRunState(state: string): state is LiveRunState {
  return (LIVE_RUN_STATES as readonly string[]).includes(state);
}

/** Debounce for the status re-query that follows a lifecycle event — same
 *  value as `useActiveScenarioRuns`, so both views settle together. */
const STATUS_REFRESH_DEBOUNCE_MS = 200;

export interface ScenarioRunHistoryEntry {
  /** When this page began tracking the run: the `start()` call, or — for an
   *  `attached` run — the moment the page attached to it (the runtime does
   *  not report a run's start time). */
  startedAt: Date;
  endedAt: Date | null;
  result: "running" | "completed" | "stopped" | "error";
  failedNodeId?: string;
  /** The run was already live in the runtime (started by a trigger, the
   *  daemon, or another client) and this page attached to it (#366). */
  attached?: boolean;
  /** Runtime run id, when the service reports one (daemon only). */
  runId?: string;
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
  /** Runtime run id of the tracked run (from `getScenarioStatus`); null when
   *  unknown — local mode never mints one. Kept after the run ends. */
  runId: string | null;
  /** While the tracked run is parked on a waiting node: the condition it
   *  awaits (action / status / timeout). Null otherwise. */
  expectation: ScenarioExpectation | null;
  /** Epoch ms when the current node began executing, per the runtime; null
   *  when unknown or no run is live. */
  currentNodeStartedAt: number | null;
  /** The initial `getScenarioStatus` query for the viewed target settled —
   *  until then `state` is "idle" only because nothing is known yet. */
  hydrated: boolean;
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
   *  active — and, even while a run IS active, is a no-op at the runtime
   *  too: `ScenarioExecutor.step()` only acts when the executor's internal
   *  state is "stepping", which nothing reaches today (`runScenario` always
   *  starts execution in oneshot mode — see `start`'s doc comment above).
   *  Kept as a thin, already-correct RPC wrapper for when step-mode
   *  execution lands; `ScenarioRunPage` deliberately does not expose a Step
   *  control (console redesign review, Finding 3) because it would be a
   *  dead button today. */
  step(): Promise<void>;
  /** Session-local, newest first. */
  runs: ScenarioRunHistoryEntry[];
}

/**
 * Drives a scenario run against the discovered v2 mechanism: `loadScenario`
 * (activates the definition into the runtime, returning its runtime
 * `scenarioId`) followed by `runScenario` (starts it). Progress is tracked
 * from the four scenario `ChargePointEvent` variants that actually exist —
 * `scenario-started` / `scenario-node-execute` / `scenario-completed` /
 * `scenario-error` — filtered to this connector + the tracked scenarioId.
 *
 * The hook also attaches to a run it did not start (#366): on mount it asks
 * `getScenarioStatus` whether the viewed scenario is already live (the
 * runtime scenarioId is the definition id in every service) and, if so,
 * hydrates state / position / expectation / runId from it; and a
 * `scenario-started` for the viewed scenario while nothing is tracked (an
 * auto-start trigger firing while the page is open) is attached the same
 * way. Because no event says a run is parked, each lifecycle event of the
 * tracked run schedules a debounced `getScenarioStatus` re-query — that is
 * what surfaces `waiting` and its expectation. There is no
 * `scenario-node-complete` or
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
  const [runId, setRunId] = useState<string | null>(null);
  const [expectation, setExpectation] = useState<ScenarioExpectation | null>(
    null,
  );
  const [currentNodeStartedAt, setCurrentNodeStartedAt] = useState<
    number | null
  >(null);
  const [hydrated, setHydrated] = useState(false);

  // Refs mirror the corresponding state so the event handler (registered
  // once per cpId/connectorId, not re-registered on every event) always
  // reads the latest value instead of a stale closure.
  const activeScenarioIdRef = useRef<string | null>(null);
  const currentNodeIdRef = useRef<string | null>(null);
  // Guards `start()` against re-entry: `state` doesn't flip to "running"
  // until `loadScenario` resolves, so a rapid second `start()` call in that
  // window would otherwise re-enter, pushing a second `runs` entry and
  // overwriting `activeScenarioIdRef` — orphaning the first run (its
  // `scenario-completed`/`scenario-error` events get filtered out once
  // `activeScenarioIdRef` points at the second run's scenarioId, so it never
  // gets `endedAt` and stays "running" forever). Set true synchronously at
  // the top of `start()` and cleared in `finally`, so it covers the whole
  // `loadScenario` + `runScenario` duration, not just cleared elsewhere.
  const isStartingRef = useRef(false);
  // True from the moment a run is known live (started here, hydrated, or
  // attached) until it ends. Distinguishes "a new run of the tracked
  // scenario started" from "the tracked run reported it started".
  const isLiveRef = useRef(false);
  // The definition id being viewed — the runtime scenarioId an externally
  // started run of it carries. A ref so the long-lived event handler reads
  // the current one.
  const viewedScenarioIdRef = useRef<string | null>(scenario?.id ?? null);
  // Every `getScenarioStatus` request captures this counter; anything that
  // makes an in-flight answer stale (target change, `start()`, the run
  // ending, a newer request) bumps it, and a stale answer is dropped.
  const statusRequestRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelStatusRefresh = useCallback(() => {
    statusRequestRef.current += 1;
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  /** Mirrors a live runtime status into the hook's state. */
  const applyLiveStatus = useCallback((status: ScenarioExecutionContext) => {
    setState(status.state as LiveRunState);
    setExpectation(status.expectation ?? null);
    setCurrentNodeStartedAt(status.currentNodeStartedAt ?? null);
    setRunId(status.runId ?? null);
    if (status.runId) {
      const knownRunId = status.runId;
      setRuns((prev) => {
        const [head, ...rest] = prev;
        if (!head || head.endedAt || head.runId) return prev;
        return [{ ...head, runId: knownRunId }, ...rest];
      });
    }
  }, []);

  /** Starts tracking a run this hook did not start. */
  const attachRun = useCallback((scenarioId: string, known?: string) => {
    activeScenarioIdRef.current = scenarioId;
    isLiveRef.current = true;
    currentNodeIdRef.current = null;
    setCurrentNodeId(null);
    setExecutedNodeIds([]);
    setError(null);
    setExpectation(null);
    setCurrentNodeStartedAt(null);
    setRunId(known ?? null);
    setState("running");
    setRuns((prev) => [
      {
        startedAt: new Date(),
        endedAt: null,
        result: "running",
        attached: true,
        ...(known ? { runId: known } : {}),
      },
      ...prev,
    ]);
  }, []);

  // Reset everything when the viewed target changes, then ask the runtime
  // whether the viewed scenario is already running — "Open run" from the
  // Active scenarios panel (and a reload of this page) land here mid-run.
  useEffect(() => {
    setState("idle");
    setCurrentNodeId(null);
    setExecutedNodeIds([]);
    setError(null);
    setRuns([]);
    setRunId(null);
    setExpectation(null);
    setCurrentNodeStartedAt(null);
    setHydrated(false);
    activeScenarioIdRef.current = null;
    currentNodeIdRef.current = null;
    isLiveRef.current = false;
    viewedScenarioIdRef.current = scenario?.id ?? null;
    cancelStatusRefresh();

    const viewedId = scenario?.id;
    if (!cpId || connectorId == null || !viewedId) {
      setHydrated(true);
      return undefined;
    }

    let cancelled = false;
    const requestId = statusRequestRef.current;
    chargePointService
      .getScenarioStatus(cpId, connectorId, viewedId)
      .then(
        (status) => status,
        (err) => {
          console.warn(
            `Failed to fetch scenario status for ${cpId}/${connectorId}/${viewedId}`,
            err,
          );
          return null;
        },
      )
      .then((status) => {
        if (cancelled) return;
        setHydrated(true);
        // `start()` or an attach already took over while this was in flight.
        if (requestId !== statusRequestRef.current) return;
        if (!status || !isLiveRunState(status.state)) return;
        attachRun(viewedId, status.runId);
        currentNodeIdRef.current = status.currentNodeId;
        setCurrentNodeId(status.currentNodeId);
        setExecutedNodeIds([...new Set(status.executedNodes)]);
        applyLiveStatus(status);
      });

    return () => {
      cancelled = true;
      cancelStatusRefresh();
    };
  }, [
    cpId,
    connectorId,
    scenario?.id,
    chargePointService,
    attachRun,
    applyLiveStatus,
    cancelStatusRefresh,
  ]);

  /** Debounced re-query of the tracked run's status. Applied only while the
   *  run is still live and the answer describes the node the events last
   *  reported — an answer that raced a newer node-execute is left to that
   *  event's own re-query. */
  const scheduleStatusRefresh = useCallback(() => {
    if (!cpId || connectorId == null) return;
    cancelStatusRefresh();
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      const scenarioId = activeScenarioIdRef.current;
      if (!scenarioId) return;
      const requestId = statusRequestRef.current;
      chargePointService
        .getScenarioStatus(cpId, connectorId, scenarioId)
        .then((status) => {
          if (requestId !== statusRequestRef.current) return;
          if (!isLiveRef.current || !status) return;
          if (!isLiveRunState(status.state)) return;
          if (status.currentNodeId !== currentNodeIdRef.current) return;
          applyLiveStatus(status);
        })
        .catch((err) => {
          console.warn(
            `Failed to refresh scenario status for ${cpId}/${connectorId}/${scenarioId}`,
            err,
          );
        });
    }, STATUS_REFRESH_DEBOUNCE_MS);
  }, [
    cpId,
    connectorId,
    chargePointService,
    applyLiveStatus,
    cancelStatusRefresh,
  ]);

  /** The tracked run ended (completed / error / confirmed stop). */
  const endLiveRun = useCallback(() => {
    isLiveRef.current = false;
    cancelStatusRefresh();
    setExpectation(null);
    setCurrentNodeStartedAt(null);
  }, [cancelStatusRefresh]);

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
        if (connectorId != null && event.connectorId !== connectorId) return;

        // A run of the viewed scenario started by someone else (auto-start
        // trigger, daemon, another tab) while this page tracks nothing live:
        // attach to it, like the mount-time hydration does.
        if (
          event.type === "scenario-started" &&
          !isLiveRef.current &&
          !isStartingRef.current &&
          (event.scenarioId === activeScenarioIdRef.current ||
            (activeScenarioIdRef.current === null &&
              event.scenarioId === viewedScenarioIdRef.current))
        ) {
          attachRun(event.scenarioId);
          scheduleStatusRefresh();
          return;
        }

        if (event.scenarioId !== activeScenarioIdRef.current) return;

        switch (event.type) {
          case "scenario-started":
            setState("running");
            scheduleStatusRefresh();
            break;
          case "scenario-node-execute":
            currentNodeIdRef.current = event.nodeId;
            setCurrentNodeId(event.nodeId);
            setExecutedNodeIds((prev) =>
              prev.includes(event.nodeId) ? prev : [...prev, event.nodeId],
            );
            if (isLiveRef.current) {
              // A new node runs: whatever the run was parked on is over
              // until the status re-query says otherwise.
              setState("running");
              setExpectation(null);
              setCurrentNodeStartedAt(null);
              scheduleStatusRefresh();
            }
            break;
          case "scenario-completed":
            endLiveRun();
            setState("completed");
            closeActiveRun("completed");
            break;
          case "scenario-error":
            endLiveRun();
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
  }, [
    cpId,
    connectorId,
    chargePointService,
    closeActiveRun,
    attachRun,
    scheduleStatusRefresh,
    endLiveRun,
  ]);

  const start = useCallback(
    async (mode?: ScenarioExecutionMode) => {
      if (!cpId || connectorId == null || !scenario) return;
      // Reentry guard: a rapid second click lands here while the first
      // call's `loadScenario`/`runScenario` are still in flight. No-op
      // until the first call resolves or fails (cleared in `finally`).
      if (isStartingRef.current) return;
      isStartingRef.current = true;
      // This page now owns the run: drop any in-flight hydration / refresh.
      cancelStatusRefresh();
      isLiveRef.current = true;

      setError(null);
      setRunId(null);
      setExpectation(null);
      setCurrentNodeStartedAt(null);
      // Reset node-tracking state up front, BEFORE `loadScenario` — not
      // only on the success path below. Otherwise a retry after a prior
      // run (completed/stopped/error) would still have `currentNodeIdRef`
      // pointing at that prior run's last node, and if THIS attempt's
      // `loadScenario` rejects before any node executes, the catch below
      // would mislabel the load-time failure with that stale node as
      // `failedNodeId`.
      currentNodeIdRef.current = null;
      setCurrentNodeId(null);
      setExecutedNodeIds([]);

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
        setState("running");

        await chargePointService.runScenario(cpId, connectorId, scenarioId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        endLiveRun();
        setError(message);
        setState("error");
        closeActiveRun("error", currentNodeIdRef.current ?? undefined);
      } finally {
        isStartingRef.current = false;
      }
    },
    [
      cpId,
      connectorId,
      scenario,
      chargePointService,
      closeActiveRun,
      cancelStatusRefresh,
      endLiveRun,
    ],
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
    endLiveRun();
    setState("idle");
    closeActiveRun("stopped");
  }, [cpId, connectorId, chargePointService, closeActiveRun, endLiveRun]);

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
    runId,
    expectation,
    currentNodeStartedAt,
    hydrated,
    start,
    stop,
    step,
    runs,
  };
}
