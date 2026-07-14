import React from "react";
import { Link } from "react-router-dom";
import { MoreHorizontal } from "lucide-react";

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

export interface ScenarioTableProps {
  items: ScenarioLibraryItem[];
  onToggleEnabled: (item: ScenarioLibraryItem, enabled: boolean) => void;
  onDuplicate: (item: ScenarioLibraryItem) => void;
  onExport: (item: ScenarioLibraryItem) => void;
  onDelete: (item: ScenarioLibraryItem) => void;
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
}) => {
  const [openMenuId, setOpenMenuId] = React.useState<string | null>(null);

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

          return (
            <TableRow key={rowKey} data-scenario-id={scenario.id}>
              <TableCell>
                <div className="font-medium text-gray-900 dark:text-gray-100">
                  {scenario.name}
                </div>
                {scenario.description && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {scenario.description}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <TargetChip cpId={cpId} connectorId={connectorId} />
              </TableCell>
              <TableCell className="text-xs text-gray-600 dark:text-gray-300">
                {triggerLabel(scenario)}
              </TableCell>
              <TableCell className="text-xs text-gray-600 dark:text-gray-300">
                {linear.isLinear ? (
                  `${linear.steps.length} steps`
                ) : (
                  <span className="inline-flex items-center rounded-md bg-indigo-100 px-1.5 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
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
                  className="h-4 w-4 rounded border-gray-300 dark:border-gray-600"
                />
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <Link
                    to={buildScenarioUrl("run", cpId, connectorId, scenario.id)}
                    className="rounded-md border border-gray-200 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
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
                    className="rounded-md border border-gray-200 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                  >
                    Edit
                  </Link>
                  <div className="relative">
                    <button
                      type="button"
                      aria-label={`More actions for ${scenario.name}`}
                      onClick={() =>
                        setOpenMenuId(openMenuId === rowKey ? null : rowKey)
                      }
                      className="rounded-md border border-gray-200 p-1 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                    {openMenuId === rowKey && (
                      <div className="absolute right-0 z-10 mt-1 w-40 rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
                        <button
                          type="button"
                          onClick={() => {
                            setOpenMenuId(null);
                            onDuplicate(item);
                          }}
                          className="block w-full px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800"
                        >
                          Duplicate
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOpenMenuId(null);
                            onExport(item);
                          }}
                          className="block w-full px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800"
                        >
                          Export JSON
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOpenMenuId(null);
                            onDelete(item);
                          }}
                          className="block w-full px-3 py-1.5 text-left text-xs text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
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
