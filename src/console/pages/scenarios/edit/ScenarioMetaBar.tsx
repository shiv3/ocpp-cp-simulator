import React from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { OCPPStatus } from "../../../../cp/domain/types/OcppTypes";
import type {
  ScenarioDefinition,
  ScenarioTrigger,
} from "../../../../cp/application/scenario/ScenarioTypes";
import TargetChip from "../../../components/TargetChip";
import { buildScenarioUrl } from "../../../lib/useAllScenarios";

export interface ScenarioMetaBarProps {
  scenario: ScenarioDefinition;
  cpId: string;
  connectorId: number | null;
  /** True when the working copy differs from the last-loaded/saved def. */
  dirty: boolean;
  isSaving?: boolean;
  onChange: (patch: Partial<ScenarioDefinition>) => void;
  onSave: () => void;
  /** A back button with this label (`← <label>`) calling `onBack`, instead
   *  of the `← Back` link to `/scenarios`. */
  backLabel?: string;
  onBack?: () => void;
  /** The Save button's text (default `Save`). */
  saveLabel?: string;
  /** The charge point / connector chip and **▶ Run**: a per-connector
   *  scenario has a target to show and run on; a Library scenario has none. */
  showTarget?: boolean;
}

/**
 * Editor's own header row: name, target, trigger, enabled toggle, and
 * save/run actions. The START node's trigger is edited here (writes
 * `scenario.trigger`) rather than as a list step — the brief keeps
 * START/END out of the step list entirely.
 *
 * Uses a plain checkbox for "Enabled" (not a Switch primitive — none is
 * installed in this repo's `src/components/ui`; a checkbox toggle is the
 * existing convention for boolean scenario flags, see
 * `LibraryTable`'s "Enabled" column and the library page's "Enabled only"
 * filter).
 */
const ScenarioMetaBar: React.FC<ScenarioMetaBarProps> = ({
  scenario,
  cpId,
  connectorId,
  dirty,
  isSaving,
  onChange,
  onSave,
  backLabel,
  onBack,
  saveLabel = "Save",
  showTarget = true,
}) => {
  const triggerType = scenario.trigger?.type ?? "manual";
  const toStatus =
    scenario.trigger?.conditions?.toStatus ?? OCPPStatus.Charging;
  const enabled = scenario.enabled !== false;
  const runUrl = buildScenarioUrl("run", cpId, connectorId, scenario.id);

  const setTrigger = (trigger: ScenarioTrigger) => onChange({ trigger });

  const handleTriggerTypeChange = (value: string) => {
    if (value === "statusChange") {
      setTrigger({ type: "statusChange", conditions: { toStatus } });
    } else {
      setTrigger({ type: "manual" });
    }
  };

  const handleToStatusChange = (value: string) => {
    setTrigger({
      type: "statusChange",
      conditions: { toStatus: value as OCPPStatus },
    });
  };

  const handleRunClick = (e: React.MouseEvent) => {
    if (
      dirty &&
      typeof window !== "undefined" &&
      !window.confirm(
        "You have unsaved changes. Run the last-saved version anyway?",
      )
    ) {
      e.preventDefault();
    }
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-cx-border pb-4">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-cx-accent hover:underline"
        >
          ← {backLabel ?? "Back"}
        </button>
      ) : (
        <Link
          to={"/scenarios"}
          className="text-sm text-cx-accent hover:underline"
        >
          ← Back
        </Link>
      )}

      <input
        aria-label="Scenario name"
        value={scenario.name}
        onChange={(e) => onChange({ name: e.target.value })}
        className="min-w-0 flex-1 border-0 bg-transparent text-[20px] font-semibold text-cx-fg focus:outline-none focus:ring-0"
      />

      {showTarget && <TargetChip cpId={cpId} connectorId={connectorId} />}

      <select
        aria-label="Trigger"
        value={triggerType}
        onChange={(e) => handleTriggerTypeChange(e.target.value)}
        className="rounded-md border border-cx-border-strong bg-transparent px-2 py-1.5 text-sm"
      >
        <option value="manual">Manual</option>
        <option value="statusChange">On status change</option>
      </select>

      {triggerType === "statusChange" && (
        <select
          aria-label="Trigger to-status"
          value={toStatus}
          onChange={(e) => handleToStatusChange(e.target.value)}
          className="rounded-md border border-cx-border-strong bg-transparent px-2 py-1.5 text-sm"
        >
          {Object.values(OCPPStatus).map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      )}

      <label className="flex items-center gap-1.5 text-sm text-cx-fg2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          className="h-4 w-4 rounded border-cx-border-strong"
        />
        Enabled
      </label>

      <div className="ml-auto flex items-center gap-2">
        {dirty && (
          <span
            role="status"
            aria-label="Unsaved changes"
            title="Unsaved changes"
            className="h-2 w-2 rounded-full bg-cx-amber"
          />
        )}
        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={!dirty || isSaving}
        >
          {saveLabel}
        </Button>
        {showTarget && (
          <Button asChild variant="outline" size="sm">
            <Link to={runUrl} onClick={handleRunClick}>
              ▶ Run
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
};

export default ScenarioMetaBar;
