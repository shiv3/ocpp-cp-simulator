import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { useT } from "../../../i18n";
import { Handle, Position, type Node } from "@xyflow/react";
import type { DelayNodeData } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";

type ExtendedDelayNodeData = DelayNodeData & {
  progress?: {
    remaining: number;
    total: number;
  };
};

const DelayNode: React.FC<NodeProps<Node<ExtendedDelayNodeData>>> = ({
  data,
  selected,
}) => {
  const t = useT();
  const progress = data.progress;
  const progressPercent = progress
    ? ((progress.total - progress.remaining) / progress.total) * 100
    : 0;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[180px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        {t("scenarioNodes.title.delay")}
      </div>
      <div className="flex items-center gap-2">
        <div className="text-2xl">⏱️</div>
        <div className="flex-1">
          <div className="font-bold text-sm text-primary">
            {data.delaySeconds}s
          </div>
          {progress && progress.remaining > 0 ? (
            <div className="text-xs text-blue-700 dark:text-blue-300 font-semibold">
              {t("scenarioNodes.delay.remaining", {
                seconds: progress.remaining.toFixed(1),
              })}
            </div>
          ) : (
            <div className="text-xs text-muted">
              {t("scenarioNodes.delay.wait")}
            </div>
          )}
        </div>
      </div>

      {/* Progress Bar */}
      {progress && progress.remaining > 0 && (
        <div className="mt-2">
          <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 dark:bg-blue-400 transition-all duration-100"
              style={{ width: `${progressPercent}%` }}
            ></div>
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(DelayNode);
