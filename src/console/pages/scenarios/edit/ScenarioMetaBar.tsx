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
import { consolePath } from "../../../routes";

export interface ScenarioMetaBarProps {
  scenario: ScenarioDefinition;
  cpId: string;
  connectorId: number | null;
  /** True when the working copy differs from the last-loaded/saved def. */
  dirty: boolean;
  isSaving?: boolean;
  onChange: (patch: Partial<ScenarioDefinition>) => void;
  onSave: () => void;
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
 * `ScenarioTable`'s "Enabled" column and the library page's "Enabled only"
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
    <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-gray-200 pb-4 dark:border-gray-800">
      <Link
        to={consolePath("/scenarios")}
        className="text-sm text-blue-600 hover:underline dark:text-blue-400"
      >
        ← Back
      </Link>

      <input
        aria-label="Scenario name"
        value={scenario.name}
        onChange={(e) => onChange({ name: e.target.value })}
        className="min-w-0 flex-1 border-0 bg-transparent text-lg font-semibold text-gray-900 focus:outline-none focus:ring-0 dark:text-gray-100"
      />

      <TargetChip cpId={cpId} connectorId={connectorId} />

      <select
        aria-label="Trigger"
        value={triggerType}
        onChange={(e) => handleTriggerTypeChange(e.target.value)}
        className="rounded-md border border-gray-300 bg-transparent px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
      >
        <option value="manual">Manual</option>
        <option value="statusChange">On status change</option>
      </select>

      {triggerType === "statusChange" && (
        <select
          aria-label="Trigger to-status"
          value={toStatus}
          onChange={(e) => handleToStatusChange(e.target.value)}
          className="rounded-md border border-gray-300 bg-transparent px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        >
          {Object.values(OCPPStatus).map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      )}

      <label className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          className="h-4 w-4 rounded border-gray-300 dark:border-gray-600"
        />
        Enabled
      </label>

      <div className="ml-auto flex items-center gap-2">
        {dirty && (
          <span
            role="status"
            aria-label="Unsaved changes"
            title="Unsaved changes"
            className="h-2 w-2 rounded-full bg-amber-500"
          />
        )}
        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={!dirty || isSaving}
        >
          Save
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to={runUrl} onClick={handleRunClick}>
            ▶ Run
          </Link>
        </Button>
      </div>
    </div>
  );
};

export default ScenarioMetaBar;
