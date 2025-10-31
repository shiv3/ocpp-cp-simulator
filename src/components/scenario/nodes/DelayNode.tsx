import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { DelayNodeData } from "../../../cp/application/scenario/ScenarioTypes";

interface ExtendedDelayNodeData extends DelayNodeData {
  progress?: {
    remaining: number;
    total: number;
  };
}

const DelayNode: React.FC<NodeProps<ExtendedDelayNodeData>> = ({ data, selected }) => {
  const progress = data.progress;
  const progressPercent = progress ? ((progress.total - progress.remaining) / progress.total) * 100 : 0;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[180px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">
        Delay
      </div>
      <div className="flex items-center gap-2">
        <div className="text-2xl">⏱️</div>
        <div className="flex-1">
          <div className="font-bold text-sm text-primary">{data.delaySeconds}s</div>
          {progress && progress.remaining > 0 ? (
            <div className="text-xs text-blue-600 dark:text-blue-400 font-semibold">
              {progress.remaining.toFixed(1)}s remaining
            </div>
          ) : (
            <div className="text-xs text-muted">Wait</div>
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

      {data.description && (
        <div className="text-xs text-muted mt-1">{data.description}</div>
      )}

      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(DelayNode);
