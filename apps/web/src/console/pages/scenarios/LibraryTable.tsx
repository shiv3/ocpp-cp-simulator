import { useTranslation } from "react-i18next";
import React from "react";
import { MoreHorizontal } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { t as tNow } from "../../../i18n";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import RunStatePill from "../../components/RunStatePill";
import { deriveDisplayedSteps } from "../../lib/scenarioSteps";
import { deriveStepLayout, layoutSteps } from "../../lib/stepLayout";
import type { ChargePointRun } from "../../lib/useAllActiveScenarioRuns";
import type { ScenarioLibraryItem } from "../../lib/useAllScenarios";

/** One library scenario with the connectors using it and their live runs. */
export interface LibraryRow {
  scenario: ScenarioDefinition;
  users: ScenarioLibraryItem[];
  runs: ChargePointRun[];
}

export interface LibraryTableProps {
  rows: LibraryRow[];
  onToggleEnabled: (row: LibraryRow, enabled: boolean) => void;
  onEdit: (row: LibraryRow) => void;
  onDuplicate: (row: LibraryRow) => void;
  onExport: (row: LibraryRow) => void;
  onDelete: (row: LibraryRow) => void;
  /** The entry open in the page's side panel (highlighted). */
  isSelected?: (row: LibraryRow) => boolean;
  /** A click on a row (not on its controls) opens or closes its panel. */
  onSelect?: (row: LibraryRow) => void;
}

const stepCount = (n: number) => tNow("scenarios.count.step", { count: n });

const connectorCount = (n: number) =>
  tNow("scenarios.count.connector", { count: n });

const Dash = () => <span className="text-cx-faint">—</span>;

/** "n steps" from the Steps view's layout, or a "graph" chip (with the node
 *  count) for a shape that view cannot draw. */
const StepsCell: React.FC<{ scenario: ScenarioDefinition }> = ({
  scenario,
}) => {
  const { t } = useTranslation();
  const layout = deriveStepLayout(scenario);
  if (layout.supported) {
    return <>{stepCount(layoutSteps(layout).length)}</>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      {stepCount(deriveDisplayedSteps(scenario).steps.length)}
      <span className="rounded-md bg-cx-sel px-1.5 py-0.5 text-xs font-medium text-cx-accent">
        {t("scenarios.table.graph")}
      </span>
    </span>
  );
};

/**
 * The Library tab's table: one row per library scenario — Scenario (name,
 * description), Steps, Used by (the connectors holding a copy), Running (the
 * live runs of those copies), Enabled, and Edit with the `…` menu
 * (Duplicate, Export JSON, Delete).
 */
const LibraryTable: React.FC<LibraryTableProps> = ({
  rows,
  onToggleEnabled,
  onEdit,
  onDuplicate,
  onExport,
  onDelete,
  isSelected,
  onSelect,
}) => {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("scenarios.table.scenario")}</TableHead>
          <TableHead>{t("scenarios.table.steps")}</TableHead>
          <TableHead>{t("scenarios.table.usedBy")}</TableHead>
          <TableHead>{t("scenarios.table.running")}</TableHead>
          <TableHead>{t("scenarios.table.enabled")}</TableHead>
          <TableHead className="text-right">
            {t("scenarios.table.edit")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const { scenario, users, runs } = row;
          const selected = isSelected?.(row) ?? false;
          return (
            <TableRow
              key={scenario.id}
              data-scenario-id={scenario.id}
              data-selected={selected ? "true" : undefined}
              onClick={(event) => {
                const target = event.target as Element;
                // The row's controls keep their own job; the `…` menu is
                // portalled, so its clicks bubble here through React only.
                if (!event.currentTarget.contains(target)) return;
                if (target.closest("button, a, input, label")) return;
                onSelect?.(row);
              }}
              className={cn(
                onSelect && "cursor-pointer",
                selected && "bg-cx-sel hover:bg-cx-sel",
              )}
            >
              <TableCell>
                <div className="font-medium text-cx-fg">{scenario.name}</div>
                {scenario.description && (
                  <div className="text-xs text-cx-muted">
                    {scenario.description}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-xs text-cx-fg2">
                <StepsCell scenario={scenario} />
              </TableCell>
              <TableCell
                className="text-xs text-cx-fg2"
                title={users
                  .map(
                    (u) =>
                      `${u.cpId}${u.connectorId === null ? "" : ` #${u.connectorId}`}`,
                  )
                  .join(", ")}
              >
                {users.length > 0 ? connectorCount(users.length) : <Dash />}
              </TableCell>
              <TableCell>
                {runs.length > 0 ? (
                  <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                    {runs.map((run) => (
                      <RunStatePill
                        key={`${run.cpId}:${run.connectorId}:${run.scenarioId}`}
                        state={run.state}
                        title={`${run.cpId} #${run.connectorId}`}
                      />
                    ))}
                  </div>
                ) : (
                  <Dash />
                )}
              </TableCell>
              <TableCell>
                <input
                  type="checkbox"
                  aria-label={t("scenarios.table.enabledFor", {
                    name: scenario.name,
                  })}
                  checked={scenario.enabled !== false}
                  onChange={(e) => onToggleEnabled(row, e.target.checked)}
                  className="h-4 w-4 rounded border-cx-border-strong"
                />
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => onEdit(row)}
                    className="rounded-md border border-cx-border px-2 py-1 text-xs font-medium text-cx-fg2 hover:bg-cx-sub"
                  >
                    {t("scenarios.table.edit")}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={t("scenarios.table.moreActions", {
                          name: scenario.name,
                        })}
                        className="rounded-md border border-cx-border p-1 text-cx-fg2 hover:bg-cx-sub"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    {/* Portalled + collision-aware: flips upward on the last
                      rows instead of being clipped by the table's
                      overflow-auto wrapper (#365). */}
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem
                        onSelect={() => onDuplicate(row)}
                        className="text-xs"
                      >
                        {t("scenarios.table.duplicate")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => onExport(row)}
                        className="text-xs"
                      >
                        {t("scenarios.table.exportJson")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => onDelete(row)}
                        className="text-xs text-cx-rose focus:bg-cx-rose/10 focus:text-cx-rose"
                      >
                        {t("scenarios.table.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};

export default LibraryTable;
