import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Event,
  Failure,
  ParseWarning,
  Session,
  SessionSummary,
} from "@ocpp-debugkit/toolkit/core";
import {
  FailureSummary,
  MessageInspector,
  SessionTimeline,
} from "@ocpp-debugkit/toolkit/react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useDataContext } from "@/data/providers/DataProvider";
import {
  logLinesToTrace,
  type SerializedLogLine,
} from "@/trace/logEntryToTrace";
import { ANALYZE_DISCLAIMER } from "@/trace/analysisDisclaimer";

import EmptyState from "../../components/EmptyState";

export interface SessionAnalysisPanelProps {
  cpId: string;
  ocppVersion?: string;
}

interface AnalysisData {
  events: Event[];
  sessions: Session[];
  failures: Failure[];
  summaries: SessionSummary[];
  warnings: ParseWarning[];
}

type PanelState =
  | { kind: "idle" }
  | { kind: "analyzing" }
  | { kind: "empty"; message: string }
  | { kind: "results"; data: AnalysisData }
  | { kind: "error"; message: string };

const NO_LOGGED_TRAFFIC_MESSAGE = "No logged traffic to analyze yet.";

/**
 * Snapshot-on-click DebugKit analysis (issue #188 PoC items 6-7): clicking
 * "Analyze" snapshots the CP's persisted logs and runs the toolkit pipeline
 * once. There is no live/continuous analysis -- re-clicking re-snapshots and
 * re-runs (deliberate; see issue #188).
 *
 * @ocpp-debugkit/toolkit is imported ONLY via its `/core` and `/react`
 * subpaths -- never the package root, never `/cli` (a module-load side
 * effect). `/react` has no runtime dependency on `/core` and is small
 * (~9 KB), so it's imported at this module's top level; this whole module is
 * itself only reachable through the lazy `import("./cp/SessionAnalysisPanel")`
 * in CpDetailPage.tsx, so it never lands in the main entry chunk. `/core` is
 * imported dynamically inside the click handler so a missing/broken install
 * fails there with our own message instead of on tab open.
 */
const SessionAnalysisPanel: React.FC<SessionAnalysisPanelProps> = ({
  cpId,
  ocppVersion,
}) => {
  const { chargePointService } = useDataContext();
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  // Nothing remounts this panel when `cpId` changes (CpDetailPage keeps one
  // lazy-loaded instance across route param changes), so `handleAnalyze`'s
  // in-flight `listStoredLogs`/dynamic-import/pipeline work for the OLD cpId
  // could otherwise land after the prop has already moved on to a new CP,
  // rendering the wrong CP's results/error under the new CP's page. This ref
  // tracks the current cpId for `handleAnalyze`'s staleness guard below, and
  // the effect resets the panel back to idle the moment cpId changes so the
  // new CP never shows a stale "analyzing"/results/error state either.
  const cpIdRef = useRef(cpId);
  useEffect(() => {
    cpIdRef.current = cpId;
    setState({ kind: "idle" });
    setSelectedEventId(null);
  }, [cpId]);

  const canAnalyze = typeof chargePointService.listStoredLogs === "function";

  const handleAnalyze = useCallback(async () => {
    // Called as a method — every real implementation reads `this` inside
    // listStoredLogs, so a detached reference breaks at runtime.
    if (!chargePointService.listStoredLogs) return;
    const requestCpId = cpId;
    setSelectedEventId(null);
    setState({ kind: "analyzing" });

    // Only commits when the panel is still showing the CP this analyze was
    // started for -- guards every post-await setState against a stale
    // result from a cpId the panel has since moved away from.
    const commit = (next: PanelState) => {
      if (cpIdRef.current !== requestCpId) return;
      setState(next);
    };

    try {
      const rows = await chargePointService.listStoredLogs(requestCpId);
      if (rows.length === 0) {
        commit({ kind: "empty", message: NO_LOGGED_TRAFFIC_MESSAGE });
        return;
      }

      const records = logLinesToTrace(rows as SerializedLogLine[], {
        ocppVersion,
        chargePointId: requestCpId,
      });
      if (records.length === 0) {
        commit({ kind: "empty", message: NO_LOGGED_TRAFFIC_MESSAGE });
        return;
      }
      const jsonl = records.map((record) => JSON.stringify(record)).join("\n");

      let core: typeof import("@ocpp-debugkit/toolkit/core");
      try {
        core = await import("@ocpp-debugkit/toolkit/core");
      } catch {
        commit({
          kind: "error",
          message: "Failed to load analysis toolkit",
        });
        return;
      }

      try {
        const { events, warnings } = core.parseOpenOcppTrace(jsonl);
        const sessions = core.buildSessionTimeline(events);
        const failures = core.detectFailures(events, sessions);
        const summaries = core.summarizeSessions(sessions, failures);
        commit({
          kind: "results",
          data: { events, sessions, failures, summaries, warnings },
        });
      } catch (err) {
        commit({
          kind: "error",
          message: `Analysis failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } catch (err) {
      commit({
        kind: "error",
        message: `Analysis failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, [chargePointService, cpId, ocppVersion]);

  const selectedEvent = useMemo(() => {
    if (state.kind !== "results") return null;
    return state.data.events.find((e) => e.id === selectedEventId) ?? null;
  }, [state, selectedEventId]);

  if (!canAnalyze) {
    return (
      <EmptyState
        title="Session analysis is not available in this runtime"
        hint={ANALYZE_DISCLAIMER}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Snapshot this charge point&apos;s stored logs and run OCPP
            DebugKit&apos;s failure-pattern analysis in your browser.
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {ANALYZE_DISCLAIMER}
          </p>
          <Button
            type="button"
            size="sm"
            disabled={state.kind === "analyzing"}
            onClick={() => void handleAnalyze()}
          >
            {state.kind === "analyzing" ? "Analyzing…" : "Analyze"}
          </Button>
          {state.kind === "error" && (
            <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">
              {state.message}
            </div>
          )}
        </CardContent>
      </Card>

      {state.kind === "empty" && <EmptyState title={state.message} />}

      {state.kind === "results" && (
        <div className="space-y-4">
          <div className="text-sm text-gray-600 dark:text-gray-300">
            {state.data.events.length} events · {state.data.sessions.length}{" "}
            sessions · {state.data.failures.length} failures
            {state.data.warnings.length > 0
              ? ` · ${state.data.warnings.length} parse warnings`
              : ""}
          </div>

          <FailureSummary failures={state.data.failures} />

          <div className="grid gap-4 md:grid-cols-2">
            <SessionTimeline
              events={state.data.events}
              selectedEventId={selectedEventId}
              onSelectEvent={setSelectedEventId}
            />
            <MessageInspector event={selectedEvent} />
          </div>
        </div>
      )}
    </div>
  );
};

export default SessionAnalysisPanel;
