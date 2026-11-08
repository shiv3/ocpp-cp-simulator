import { useTranslation } from "react-i18next";
import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position, type Node } from "@xyflow/react";
import type { StatusTriggerNodeData } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

type ExtendedStatusTriggerNodeData = StatusTriggerNodeData & {
  progress?: {
    remaining: number;
    total: number;
  };
};

const StatusTriggerNode: React.FC<
  NodeProps<Node<ExtendedStatusTriggerNodeData>>
> = ({ data, selected }) => {
  const { t } = useTranslation();
  const progress = data.progress;
  const progressPercent = progress
    ? ((progress.total - progress.remaining) / progress.total) * 100
    : 0;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-orange-50 dark:bg-orange-900 min-w-[180px] ${
        selected
          ? "border-blue-500"
          : "border-orange-400 dark:border-orange-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-orange-700 dark:text-orange-300 mb-1">
        {t("scenarioNodes.title.statusTrigger")}
      </div>
      <div className="font-bold text-sm text-primary mb-1">{data.label}</div>
      <div className="text-xs text-muted">
        {t("scenarioNodes.waitFor")}{" "}
        <span className="font-semibold">{data.targetStatus}</span>
      </div>
      {data.timeout !== undefined && data.timeout > 0 && (
        <div className="text-xs text-muted">
          {t("scenarioNodes.timeout", { seconds: data.timeout })}
          {progress && progress.remaining > 0 && (
            <span className="ml-1 text-orange-700 dark:text-orange-300 font-semibold">
              {t("scenarioNodes.secondsLeft", {
                seconds: progress.remaining.toFixed(1),
              })}
            </span>
          )}
        </div>
      )}

      {/* Progress Bar */}
      {progress && progress.remaining > 0 && (
        <div className="mt-2">
          <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-orange-500 dark:bg-orange-400 transition-all duration-100"
              style={{ width: `${progressPercent}%` }}
            ></div>
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(StatusTriggerNode);
