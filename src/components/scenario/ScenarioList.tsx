import React from "react";
import { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import { Play, Pencil, Trash2, Plus, Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ScenarioListProps {
  scenarios: ScenarioDefinition[];
  activeScenarioIds: string[];
  onCreateScenario: () => void;
  onEditScenario: (scenarioId: string) => void;
  onDeleteScenario: (scenarioId: string) => void;
  onToggleEnabled: (scenarioId: string, enabled: boolean) => void;
  onManualExecute?: (scenarioId: string) => void;
  onStopScenario?: (scenarioId: string) => void;
}

export const ScenarioList: React.FC<ScenarioListProps> = ({
  scenarios,
  activeScenarioIds,
  onCreateScenario,
  onEditScenario,
  onDeleteScenario,
  onToggleEnabled,
  onManualExecute,
  onStopScenario,
}) => {
  /**
   * Get trigger display text
   */
  const getTriggerText = (scenario: ScenarioDefinition): string => {
    if (!scenario.trigger || scenario.trigger.type === "manual") {
      return "Manual";
    }

    if (scenario.trigger.type === "statusChange") {
      const conditions = scenario.trigger.conditions;
      if (!conditions) {
        return "Status Change (Any)";
      }

      const parts: string[] = [];
      if (conditions.fromStatus) {
        parts.push(`from ${conditions.fromStatus}`);
      }
      if (conditions.toStatus) {
        parts.push(`to ${conditions.toStatus}`);
      }

      return parts.length > 0
        ? `Status Change (${parts.join(" ")})`
        : "Status Change (Any)";
    }

    return "Unknown";
  };

  /**
   * Get execution mode badge class
   */
  const getExecutionModeBadgeClass = (
    mode?: "oneshot" | "step"
  ): string => {
    switch (mode) {
      case "step":
        return "bg-amber-500 hover:bg-amber-600 text-white";
      case "oneshot":
      default:
        return "bg-emerald-500 hover:bg-emerald-600 text-white";
    }
  };

  /**
   * Get trigger badge class
   */
  const getTriggerBadgeClass = (type?: "manual" | "statusChange"): string => {
    switch (type) {
      case "statusChange":
        return "bg-purple-500 hover:bg-purple-600 text-white";
      case "manual":
      default:
        return "bg-gray-500 hover:bg-gray-600 text-white";
    }
  };

  return (
    <TooltipProvider>
      <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-900">
        {/* Header */}
        <div className="panel p-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Scenarios
            </h3>
            <Button size="sm" onClick={onCreateScenario}>
              <Plus className="mr-2 h-4 w-4" />
              New Scenario
            </Button>
          </div>
        </div>

      {/* Scenario List */}
      <div className="flex-1 overflow-y-auto p-3">
        {scenarios.length === 0 ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            No scenarios. Click "New Scenario" to create one.
          </div>
        ) : (
          <div className="space-y-2">
            {scenarios.map((scenario) => {
              const isActive = activeScenarioIds.includes(scenario.id);
              const isEnabled = scenario.enabled !== false;

              return (
                <div
                  key={scenario.id}
                  className={`panel p-3 border-l-4 ${
                    isActive
                      ? "border-green-500 bg-green-50 dark:bg-green-900/20"
                      : isEnabled
                        ? "border-blue-500"
                        : "border-gray-300 dark:border-gray-600 opacity-60"
                  }`}
                >
                  {/* Scenario Header */}
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="font-semibold text-gray-900 dark:text-white">
                          {scenario.name}
                        </h4>
                        {isActive && (
                          <Badge className="bg-emerald-500 hover:bg-emerald-600 text-white">
                            Running
                          </Badge>
                        )}
                      </div>
                      {scenario.description && (
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                          {scenario.description}
                        </p>
                      )}
                    </div>

                    {/* Toggle Enable/Disable */}
                    <div className="flex items-center gap-2 ml-2">
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          className="sr-only peer"
                          checked={isEnabled}
                          onChange={(e) =>
                            onToggleEnabled(scenario.id, e.target.checked)
                          }
                        />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                        <span className="ms-3 text-sm font-medium text-gray-900 dark:text-gray-300">
                          {isEnabled ? "Enabled" : "Disabled"}
                        </span>
                      </label>
                    </div>
                  </div>

                  {/* Scenario Info */}
                  <div className="flex flex-wrap gap-2 mb-2">
                    <Badge className={getTriggerBadgeClass(scenario.trigger?.type)}>
                      {getTriggerText(scenario)}
                    </Badge>
                    <Badge className={getExecutionModeBadgeClass(scenario.defaultExecutionMode)}>
                      {scenario.defaultExecutionMode || "oneshot"}
                    </Badge>
                    <Badge className="bg-gray-500 hover:bg-gray-600 text-white">
                      {scenario.nodes.length} nodes
                    </Badge>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex gap-2">
                    {/* Manual Execute/Stop */}
                    {isActive ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => onStopScenario?.(scenario.id)}
                          >
                            <Pause className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Stop Scenario</TooltipContent>
                      </Tooltip>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="success"
                            onClick={() => onManualExecute?.(scenario.id)}
                            disabled={!isEnabled}
                          >
                            <Play className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Run Manually</TooltipContent>
                      </Tooltip>
                    )}

                    {/* Edit */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          onClick={() => onEditScenario(scenario.id)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Edit Scenario</TooltipContent>
                    </Tooltip>

                    {/* Delete */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Are you sure you want to delete "${scenario.name}"?`
                              )
                            ) {
                              onDeleteScenario(scenario.id);
                            }
                          }}
                          disabled={isActive}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Delete Scenario</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
    </TooltipProvider>
  );
};
