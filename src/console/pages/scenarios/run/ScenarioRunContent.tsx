import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Maximize2, Settings, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDataContext } from "@/data/providers/DataProvider";
import type { ScenarioDefinition } from "../../../../cp/application/scenario/ScenarioTypes";
import EmptyState from "../../../components/EmptyState";
import RunStatePill from "../../../components/RunStatePill";
import SegmentedControl from "../../../components/SegmentedControl";
import WaitControls from "../../../components/WaitControls";
import WaitingExpectation from "../../../components/WaitingExpectation";
import { formatElapsed } from "../../../lib/scenarioExpectation";
import { isLiveRunState } from "../../../lib/scenarioRunState";
import { deriveDisplayedSteps } from "../../../lib/scenarioSteps";
import { deriveStepLayout, layoutSteps } from "../../../lib/stepLayout";
import {
  editScenarioUrl,
  scenarioEditTarget,
} from "../../../lib/scenarioLibrary";
import { useLibraryEditorBinding } from "../../../lib/useLibraryEditorBinding";
import { buildScenarioUrl } from "../../../lib/useAllScenarios";
import {
  useScenarioRun,
  type UseScenarioRunResult,
} from "../../../lib/useScenarioRun";
import ScenarioEditorContent, {
  type ScenarioEditorContentProps,
} from "../edit/ScenarioEditorContent";
import RunTimeline from "./RunTimeline";
import StepsGraphView from "./StepsGraphView";
import StepsView from "./StepsView";

type RunView = "steps" | "graph";

const VIEW_OPTIONS: ReadonlyArray<{ value: RunView; label: string }> = [
  { value: "steps", label: "Steps" },
  { value: "graph", label: "Graph" },
];

interface LoadedDefinition {
  scenario: ScenarioDefinition | null;
  /** The scope the definition was found in — the editor's target. */
  scopeConnectorId: number | null;
  isLoading: boolean;
}

/**
 * Loads the definition the run executes. A run on a connector may come from
 * the charge point's own scope (a charge-point-scope scenario runs per
 * connector), so that scope is the fallback. A new `version` re-reads it
 * (after an edit) and keeps showing the old one meanwhile.
 */
function useRunDefinition(
  cpId: string,
  connectorId: number | null,
  scenarioId: string,
  version = 0,
): LoadedDefinition {
  const { chargePointService } = useDataContext();
  const [loaded, setLoaded] = useState<LoadedDefinition>({
    scenario: null,
    scopeConnectorId: connectorId,
    isLoading: true,
  });
  const loadedKey = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const key = `${cpId}\n${connectorId}\n${scenarioId}`;
    if (loadedKey.current !== key) {
      loadedKey.current = key;
      setLoaded({
        scenario: null,
        scopeConnectorId: connectorId,
        isLoading: true,
      });
    }
    const scopes = connectorId == null ? [null] : [connectorId, null];

    void (async () => {
      for (const scope of scopes) {
        try {
          const defs = await chargePointService.listScenarioDefinitions(
            cpId,
            scope,
          );
          const found = (defs ?? []).find((d) => d.id === scenarioId);
          if (found) {
            if (!cancelled) {
              setLoaded({
                scenario: found,
                scopeConnectorId: scope,
                isLoading: false,
              });
            }
            return;
          }
        } catch (err) {
          console.error("Failed to load scenario definitions", err);
        }
      }
      if (!cancelled) {
        setLoaded({
          scenario: null,
          scopeConnectorId: connectorId,
          isLoading: false,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chargePointService, cpId, connectorId, scenarioId, version]);

  return loaded;
}

/** The panel editor on a Library entry: its users and the re-pushing Save
 *  come from the Library, read here. */
const LibraryPanelEditor: React.FC<
  Omit<ScenarioEditorContentProps, "library">
> = (props) => {
  const library = useLibraryEditorBinding(props.scenarioId);
  return <ScenarioEditorContent {...props} library={library} />;
};

export interface ScenarioRunContentProps {
  cpId: string;
  /** null for a charge-point-scope scenario (it cannot be started here). */
  connectorId: number | null;
  scenarioId: string;
  /** `panel`: beside a list or the charge point page (always Steps, expand
   *  and close buttons). `page`: the read-only run page (`/scenarios/run`). */
  variant: "panel" | "page";
  /** page: the run the URL names, for the "no longer active" banner. */
  runId?: string | null;
  /** panel: the close button. */
  onClose?: () => void;
  /** page: what goes under the steps, given the run (the run history). */
  footer?: (run: UseScenarioRunResult) => React.ReactNode;
  /** panel: the editor in place of the run (`&edit=1`). Without
   *  `onEditingChange`, **Edit scenario** links to the editor page. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** panel: filled with the editor's Cancel while editing (the host's Esc). */
  cancelEditRef?: React.RefObject<(() => void) | null>;
}

/**
 * One scenario run: name and target, state, progress, Start / Stop, the wait
 * controls while parked, **Edit scenario** (in the panel: the editor in place
 * of the run, `editing`), then the steps (`StepsView`, or
 * the Graph drawing on the page; `RunTimeline`'s flat list for a shape the
 * layout cannot draw). The run comes from `useScenarioRun`, which attaches
 * to a run already live in the runtime (#366) — opening this never starts
 * one.
 *
 * There is no Step button: `runScenario` always starts a run in oneshot
 * mode, so the executor's "stepping" state (which `stepScenario` needs) is
 * unreachable from the console — a Step button would be a dead control.
 */
const ScenarioRunContent: React.FC<ScenarioRunContentProps> = ({
  cpId,
  connectorId,
  scenarioId,
  variant,
  runId: requestedRunId,
  onClose,
  footer,
  editing: editingProp = false,
  onEditingChange,
  cancelEditRef,
}) => {
  const isPanel = variant === "panel";
  const editing = isPanel && editingProp && onEditingChange !== undefined;
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  // Leaving the editor re-reads the definition, which a Save may have
  // changed (a Library copy is re-pushed).
  const [definitionVersion, setDefinitionVersion] = useState(0);
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (wasEditing.current && !editing) setDefinitionVersion((v) => v + 1);
    wasEditing.current = editing;
  }, [editing]);
  const { scenario, scopeConnectorId, isLoading } = useRunDefinition(
    cpId,
    connectorId,
    scenarioId,
    definitionVersion,
  );
  const run = useScenarioRun(cpId || null, connectorId, scenario);
  const {
    state,
    currentNodeId,
    executedNodeIds,
    error,
    runId,
    expectation,
    currentNodeStartedAt,
    waitDeadlineAt,
    hydrated,
    start,
    stop,
    controlWait,
    runs,
  } = run;
  const isRunning = isLiveRunState(state);
  // The elapsed time ticks only while the run is live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [isRunning]);

  const layout = useMemo(
    () => (scenario ? deriveStepLayout(scenario) : null),
    [scenario],
  );
  // The count follows what the body draws: the layout's steps, or the flat
  // list RunTimeline falls back to.
  const steps = useMemo(() => {
    if (!scenario || !layout) return [];
    return layout.supported
      ? layoutSteps(layout)
      : deriveDisplayedSteps(scenario).steps;
  }, [scenario, layout]);
  const executedCount = steps.filter((s) =>
    executedNodeIds.includes(s.id),
  ).length;
  const progress =
    steps.length > 0 ? Math.min(100, (executedCount / steps.length) * 100) : 0;
  const startedAt = currentNodeStartedAt ?? runs[0]?.startedAt.getTime();
  const elapsed =
    isRunning && startedAt != null ? formatElapsed(now - startedAt) : null;

  const view: RunView =
    !isPanel && searchParams.get("view") === "graph" ? "graph" : "steps";
  const setView = (next: RunView) => {
    const params = new URLSearchParams(searchParams);
    if (next === "graph") params.set("view", "graph");
    else params.delete("view");
    // A view switch is not a navigation worth a history entry.
    setSearchParams(params, { replace: true });
  };

  // The run the URL named has ended or been superseded. Unknowable without a
  // runtime runId (Local mode), so no banner there.
  const requestedRunGone =
    hydrated &&
    !!requestedRunId &&
    (!isRunning || (runId != null && runId !== requestedRunId));

  // `useScenarioRun.start()` needs a connector (`loadScenario` is
  // connector-scoped): rather than a Start that silently does nothing,
  // disable it and say why.
  const cpScopeScenario = connectorId == null;

  const closeButton = isPanel && onClose && (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="px-2"
      aria-label="Close side panel"
      title="Close (Esc)"
      onClick={onClose}
    >
      <X className="h-3.5 w-3.5" />
    </Button>
  );

  if (isLoading) {
    return <div className="text-sm text-cx-muted">Loading…</div>;
  }

  if (!scenario || !layout) {
    return (
      <div>
        {closeButton && (
          <div className="mb-2 flex justify-end">{closeButton}</div>
        )}
        <EmptyState
          title="Scenario not found"
          hint={`No scenario "${scenarioId}" for ${cpId}${
            connectorId != null ? ` · connector ${connectorId}` : ""
          }.`}
        />
      </div>
    );
  }

  if (editing) {
    const target = scenarioEditTarget(cpId, scopeConnectorId, scenario);
    const editorProps: Omit<ScenarioEditorContentProps, "library"> = {
      variant: "panel",
      cpId: target.cpId,
      connectorId: target.connectorId,
      scenarioId: target.scenarioId,
      onCancel: () => onEditingChange?.(false),
      cancelRef: cancelEditRef,
      expand: {
        to: editScenarioUrl(cpId, scopeConnectorId, scenario),
        label: target.library
          ? "Open in the Library editor"
          : "Open in the editor",
      },
      onClose,
    };
    return target.library ? (
      <LibraryPanelEditor key={target.scenarioId} {...editorProps} />
    ) : (
      <ScenarioEditorContent key={target.scenarioId} {...editorProps} />
    );
  }

  const Title = isPanel ? "h2" : "h1";
  const here = `${location.pathname}${location.search}`;

  return (
    <div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Title
            className={
              isPanel
                ? "truncate text-[17px] font-semibold text-cx-fg"
                : "truncate text-xl font-semibold text-cx-fg"
            }
          >
            {scenario.name}
          </Title>
          <div className="mt-0.5 font-mono text-xs text-cx-muted">
            {cpId}
            {connectorId != null && ` #${connectorId}`}
          </div>
        </div>
        {isPanel && (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              asChild
              variant="outline"
              size="sm"
              className="px-2"
              title="Open the run as a full page"
            >
              <Link
                to={buildScenarioUrl("run", cpId, connectorId, scenarioId, {
                  runId,
                })}
                // Back on the run page returns here, panel open.
                state={{ from: here }}
                aria-label="Open the run as a full page"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Link>
            </Button>
            {closeButton}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <RunStatePill
          state={state}
          label={state.charAt(0).toUpperCase() + state.slice(1)}
        />
        <span className="font-mono text-xs text-cx-muted">
          {executedCount} / {steps.length}
          {elapsed && ` · ${elapsed}`}
        </span>
        {runId && (
          <span
            className="font-mono text-xs text-cx-faint"
            title="Runtime run id"
          >
            {runId}
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label="Steps executed"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={executedCount}
        className="mt-2 h-[3px] overflow-hidden rounded-full bg-cx-sub"
      >
        <div
          className="h-full bg-cx-accent"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isRunning ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => void stop()}
          >
            Stop
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="success"
            disabled={cpScopeScenario}
            aria-describedby={
              cpScopeScenario ? `cp-scope-note-${variant}` : undefined
            }
            onClick={() => void start()}
          >
            Start
          </Button>
        )}
        {isPanel && onEditingChange ? (
          // In the panel itself; a copy of a Library scenario edits the
          // Library entry there too.
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onEditingChange(true)}
          >
            <Settings className="h-3.5 w-3.5" />
            Edit scenario
          </Button>
        ) : (
          <Button asChild variant="outline" size="sm">
            <Link
              // A copy of a Library scenario is edited in the Library.
              to={editScenarioUrl(cpId, scopeConnectorId, scenario)}
            >
              <Settings className="h-3.5 w-3.5" />
              Edit scenario
            </Link>
          </Button>
        )}
        {!isPanel && layout.supported && (
          <SegmentedControl
            label="View"
            options={VIEW_OPTIONS}
            value={view}
            onChange={setView}
            className="ml-auto"
          />
        )}
      </div>

      {requestedRunGone && (
        <div className="mt-3 rounded-md border border-cx-accent/40 bg-cx-accent/10 px-3 py-2 text-sm text-cx-accent">
          Run {requestedRunId} is no longer active
          {isRunning && runId ? ` — showing the current run ${runId}.` : "."}
        </div>
      )}

      {state === "waiting" && expectation && (
        <div className="mt-3 flex flex-col gap-2 rounded-md border border-cx-amber/40 bg-cx-amber/10 px-3 py-2 text-sm text-cx-amber">
          <WaitingExpectation
            expectation={expectation}
            currentNodeStartedAt={currentNodeStartedAt}
            waitDeadlineAt={waitDeadlineAt}
          />
          <WaitControls
            canExtend={waitDeadlineAt != null}
            onControl={controlWait}
          />
        </div>
      )}

      {cpScopeScenario && (
        <div
          id={`cp-scope-note-${variant}`}
          className="mt-3 rounded-md border border-cx-amber/40 bg-cx-amber/10 px-3 py-2 text-sm text-cx-amber"
        >
          This is a charge-point-scope scenario — it runs automatically per
          connector when its trigger fires, not via a manual Start here. Start
          is disabled on this console.
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-md border border-cx-rose/40 bg-cx-rose/10 px-3 py-2 text-sm text-cx-rose">
          {error}
        </div>
      )}

      <div
        className={
          isPanel
            ? "mt-5"
            : "mt-4 rounded-[10px] border border-cx-border bg-cx-card p-4 shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none"
        }
      >
        {!layout.supported ? (
          <RunTimeline
            scenario={scenario}
            currentNodeId={currentNodeId}
            executedNodeIds={executedNodeIds}
            state={state}
          />
        ) : view === "graph" ? (
          <StepsGraphView
            layout={layout}
            currentNodeId={currentNodeId}
            executedNodeIds={executedNodeIds}
            state={state}
          />
        ) : (
          <StepsView
            layout={layout}
            currentNodeId={currentNodeId}
            executedNodeIds={executedNodeIds}
            state={state}
          />
        )}
      </div>

      {footer && <div className="mt-4">{footer(run)}</div>}
    </div>
  );
};

export default ScenarioRunContent;
