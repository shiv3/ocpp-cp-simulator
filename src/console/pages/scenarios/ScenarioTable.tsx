import React from "react";
import { Link } from "react-router-dom";
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
import { deriveLinearSteps } from "../../lib/scenarioSteps";
import {
  buildScenarioUrl,
  type ScenarioLibraryItem,
} from "../../lib/useAllScenarios";
import TargetChip from "../../components/TargetChip";
import { cn } from "@/lib/utils";

export interface ScenarioTableProps {
  items: ScenarioLibraryItem[];
  onToggleEnabled: (item: ScenarioLibraryItem, enabled: boolean) => void;
  onDuplicate: (item: ScenarioLibraryItem) => void;
  onExport: (item: ScenarioLibraryItem) => void;
  onDelete: (item: ScenarioLibraryItem) => void;
  /** The entry open in the page's side panel (highlighted). */
  isSelected?: (item: ScenarioLibraryItem) => boolean;
  /** A click on a row (not on its controls) opens or closes its panel. */
  onSelect?: (item: ScenarioLibraryItem) => void;
}

function triggerLabel(scenario: ScenarioLibraryItem["scenario"]): string {
  const trigger = scenario.trigger;
  if (!trigger || trigger.type === "manual") return "Manual";
  const to = trigger.conditions?.toStatus;
  const from = trigger.conditions?.fromStatus;
  if (to && from) return `On status ${from} → ${to}`;
  if (to) return `On status → ${to}`;
  return "On status change";
}

const ScenarioTable: React.FC<ScenarioTableProps> = ({
  items,
  onToggleEnabled,
  onDuplicate,
  onExport,
  onDelete,
  isSelected,
  onSelect,
}) => {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Target</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Steps</TableHead>
          <TableHead>Enabled</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const { scenario, cpId, connectorId } = item;
          const linear = deriveLinearSteps(scenario);
          const enabled = scenario.enabled !== false;
          const rowKey = `${cpId}:${connectorId ?? "cp"}:${scenario.id}`;
          const selected = isSelected?.(item) ?? false;

          return (
            <TableRow
              key={rowKey}
              data-scenario-id={scenario.id}
              data-selected={selected ? "true" : undefined}
              onClick={(event) => {
                const target = event.target as Element;
                // The row's controls keep their own job; the `…` menu is
                // portalled, so its clicks bubble here through React only.
                if (!event.currentTarget.contains(target)) return;
                if (target.closest("button, a, input, label")) return;
                onSelect?.(item);
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
              <TableCell>
                <TargetChip cpId={cpId} connectorId={connectorId} />
              </TableCell>
              <TableCell className="text-xs text-cx-fg2">
                {triggerLabel(scenario)}
              </TableCell>
              <TableCell className="text-xs text-cx-fg2">
                {linear.isLinear ? (
                  `${linear.steps.length} steps`
                ) : (
                  <span className="inline-flex items-center rounded-md bg-cx-sel px-1.5 py-0.5 text-xs font-medium text-cx-accent">
                    graph
                  </span>
                )}
              </TableCell>
              <TableCell>
                <input
                  type="checkbox"
                  aria-label={`Enabled: ${scenario.name}`}
                  checked={enabled}
                  onChange={(e) => onToggleEnabled(item, e.target.checked)}
                  className="h-4 w-4 rounded border-cx-border-strong"
                />
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <Link
                    to={buildScenarioUrl("run", cpId, connectorId, scenario.id)}
                    className="rounded-md border border-cx-border px-2 py-1 text-xs font-medium text-cx-fg2 hover:bg-cx-sub"
                  >
                    Run
                  </Link>
                  <Link
                    to={buildScenarioUrl(
                      "edit",
                      cpId,
                      connectorId,
                      scenario.id,
                    )}
                    className="rounded-md border border-cx-border px-2 py-1 text-xs font-medium text-cx-fg2 hover:bg-cx-sub"
                  >
                    Edit
                  </Link>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`More actions for ${scenario.name}`}
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
                        onSelect={() => onDuplicate(item)}
                        className="text-xs"
                      >
                        Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => onExport(item)}
                        className="text-xs"
                      >
                        Export JSON
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => onDelete(item)}
                        className="text-xs text-cx-rose focus:bg-cx-rose/10 focus:text-cx-rose"
                      >
                        Delete
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

export default ScenarioTable;
