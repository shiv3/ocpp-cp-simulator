import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { Settings, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ScenarioDefinition } from "../../../cp/application/scenario/ScenarioTypes";
import EmptyState from "../../components/EmptyState";
import { LIVE_RUN_STATE_STYLES } from "../../lib/scenarioRunState";
import { deriveDisplayedSteps } from "../../lib/scenarioSteps";
import {
  editScenarioUrl,
  isLibraryScope,
  libraryEditorUsers,
  runsOfLibraryScenario,
  scenarioEditTarget,
  usedBy as usedByOf,
} from "../../lib/scenarioLibrary";
import { deriveStepLayout, layoutSteps } from "../../lib/stepLayout";
import type { ChargePointRun } from "../../lib/useAllActiveScenarioRuns";
import type { ScenarioLibraryItem } from "../../lib/useAllScenarios";
import ScenarioEditorContent from "./edit/ScenarioEditorContent";
import RunTimeline from "./run/RunTimeline";
import StepsView from "./run/StepsView";

export interface ScenarioDefinitionPanelProps {
  cpId: string;
  /** The definition's scope: a connector, or null for the charge point. */
  connectorId: number | null;
  scenarioId: string;
  /** null while the library loads, or when the entry is gone. */
  scenario: ScenarioDefinition | null;
  isLoading: boolean;
  /** Every live run (the Scenarios page's `useAllActiveScenarioRuns`). */
  runs: ChargePointRun[];
  /** Every per-charge-point definition (`useScenarioLibrary().items`): a
   *  Library entry's users are the scopes holding a copy of it. */
  items?: ScenarioLibraryItem[];
  onClose: () => void;
  /** The panel shows the editor (`&edit=1`) in place of the read view. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** Saves a Library scenario and re-pushes it to its users (the page's
   *  `useScenarioLibrary().save`). */
  saveLibrary?: (scenario: ScenarioDefinition) => Promise<void>;
  /** Filled with the editor's Cancel while editing (the host's Esc). */
  cancelEditRef?: React.RefObject<(() => void) | null>;
}

interface UsedByChip {
  key: string;
  cpId: string;
  connectorId: number | null;
  /** The live run there, if any. */
  run: ChargePointRun | undefined;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * A Library entry in the Scenarios page's side panel: what the scenario does
 * (its steps, no run state), **Used by** (the connectors assigned a copy of
 * it, a running one marked with its run state), and **Edit scenario**, which
 * turns the panel into the editor (`editing`; Save re-pushes to the users as
 * the Library editor's does). A definition of a charge point's own scope (an
 * older link) lists the connectors with a live run of it instead.
 */
const ScenarioDefinitionPanel: React.FC<ScenarioDefinitionPanelProps> = ({
  cpId,
  connectorId,
  scenarioId,
  scenario,
  isLoading,
  runs,
  items = [],
  onClose,
  editing = false,
  onEditingChange,
  saveLibrary,
  cancelEditRef,
}) => {
  const layout = useMemo(
    () => (scenario ? deriveStepLayout(scenario) : null),
    [scenario],
  );

  const closeButton = (
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

  if (!scenario || !layout) {
    return (
      <div>
        <div className="mb-2 flex justify-end">{closeButton}</div>
        {isLoading ? (
          <p className="text-sm text-cx-muted">Loading…</p>
        ) : (
          <EmptyState
            title="Scenario not found"
            hint={`No scenario "${scenarioId}" for ${cpId}.`}
          />
        )}
      </div>
    );
  }

  if (editing && onEditingChange) {
    const target = scenarioEditTarget(cpId, connectorId, scenario);
    return (
      <ScenarioEditorContent
        key={`${target.cpId}\n${target.scenarioId}`}
        variant="panel"
        cpId={target.cpId}
        connectorId={target.connectorId}
        scenarioId={target.scenarioId}
        library={
          target.library && saveLibrary
            ? {
                users: libraryEditorUsers(items, runs, target.scenarioId),
                save: saveLibrary,
              }
            : undefined
        }
        onCancel={() => onEditingChange(false)}
        cancelRef={cancelEditRef}
        expand={{
          to: editScenarioUrl(cpId, connectorId, scenario),
          label: target.library
            ? "Open in the Library editor"
            : "Open in the editor",
        }}
        onClose={onClose}
      />
    );
  }

  let usedBy: UsedByChip[];
  if (isLibraryScope(cpId)) {
    const live = runsOfLibraryScenario(runs, items, scenario.id);
    usedBy = usedByOf(items, scenario.id).map((user) => ({
      key: `${user.cpId}:${user.connectorId ?? "cp"}`,
      cpId: user.cpId,
      connectorId: user.connectorId,
      run: live.find(
        (run) =>
          run.cpId === user.cpId &&
          run.scenarioId === user.scenario.id &&
          (user.connectorId === null || run.connectorId === user.connectorId),
      ),
    }));
  } else {
    // A charge-point-scope scenario runs on any connector of its charge point.
    usedBy = runs
      .filter(
        (run) =>
          run.cpId === cpId &&
          run.scenarioId === scenario.id &&
          (connectorId === null || run.connectorId === connectorId),
      )
      .map((run) => ({
        key: `${run.cpId}:${run.connectorId}`,
        cpId: run.cpId,
        connectorId: run.connectorId,
        run,
      }));
  }
  const branchCount = layout.fork?.branches.length ?? 0;
  const meta = layout.supported
    ? [
        plural(layoutSteps(layout).length, "step", "steps"),
        ...(branchCount > 0 ? [plural(branchCount, "branch", "branches")] : []),
      ].join(" · ")
    : `${plural(deriveDisplayedSteps(scenario).steps.length, "step", "steps")} · graph`;

  return (
    <div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold text-cx-fg">
            {scenario.name}
          </h2>
          <div className="mt-0.5 font-mono text-xs text-cx-muted">
            {isLibraryScope(cpId) ? (
              <span className="font-sans">Library</span>
            ) : (
              <>
                {cpId}
                {connectorId != null ? ` #${connectorId}` : " · charge point"}
              </>
            )}
            <span className="font-sans"> · {meta}</span>
          </div>
        </div>
        {closeButton}
      </div>

      {scenario.description && (
        <p className="mt-2 text-sm text-cx-fg2">{scenario.description}</p>
      )}

      <div className="mt-3">
        {onEditingChange ? (
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
            <Link to={editScenarioUrl(cpId, connectorId, scenario)}>
              <Settings className="h-3.5 w-3.5" />
              Edit scenario
            </Link>
          </Button>
        )}
      </div>

      <div className="mt-4">
        <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-cx-muted">
          Used by
        </h3>
        {usedBy.length === 0 ? (
          <p className="text-sm text-cx-muted">
            {isLibraryScope(cpId)
              ? "no connector uses it"
              : "no connector running it"}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {usedBy.map((chip) => (
              <Link
                key={chip.key}
                to={
                  chip.connectorId === null
                    ? `/cp/${encodeURIComponent(chip.cpId)}`
                    : `/cp/${encodeURIComponent(chip.cpId)}?connector=${chip.connectorId}`
                }
                title={chip.run?.state}
                data-running={chip.run ? "true" : undefined}
                className="inline-flex items-center gap-1.5 rounded-md border border-cx-border bg-cx-card px-2 py-0.5 font-mono text-xs text-cx-fg2 hover:border-cx-border-strong hover:text-cx-fg"
              >
                {chip.run && (
                  <span
                    aria-hidden
                    className={cn(
                      "h-[7px] w-[7px] rounded-full",
                      LIVE_RUN_STATE_STYLES[chip.run.state],
                    )}
                  />
                )}
                {chip.cpId}
                {chip.connectorId === null
                  ? " · charge point"
                  : ` #${chip.connectorId}`}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="mt-5">
        {layout.supported ? (
          <StepsView layout={layout} />
        ) : (
          <RunTimeline
            scenario={scenario}
            currentNodeId={null}
            executedNodeIds={[]}
            state="idle"
          />
        )}
      </div>
    </div>
  );
};

export default ScenarioDefinitionPanel;
