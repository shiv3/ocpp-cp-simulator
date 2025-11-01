import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { RemoteStartTriggerNodeData } from "../../../cp/application/scenario/ScenarioTypes";

interface ExtendedRemoteStartTriggerNodeData extends RemoteStartTriggerNodeData {
  progress?: {
    remaining: number;
    total: number;
  };
}

const RemoteStartTriggerNode: React.FC<NodeProps<ExtendedRemoteStartTriggerNodeData>> = ({
  data,
  selected,
}) => {
  const progress = data.progress;
  const progressPercent = progress ? ((progress.total - progress.remaining) / progress.total) * 100 : 0;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-purple-50 dark:bg-purple-900 min-w-[180px] ${
        selected ? "border-blue-500" : "border-purple-400 dark:border-purple-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-purple-600 dark:text-purple-300 mb-1">
        Remote Start Trigger
      </div>
      <div className="font-bold text-sm text-primary mb-1">{data.label}</div>
      {data.timeout !== undefined && data.timeout > 0 && (
        <div className="text-xs text-muted">
          Timeout: {data.timeout}s
          {progress && progress.remaining > 0 && (
            <span className="ml-1 text-purple-600 dark:text-purple-400 font-semibold">
              ({progress.remaining.toFixed(1)}s left)
            </span>
          )}
        </div>
      )}
      {(!data.timeout || data.timeout === 0) && (
        <div className="text-xs text-muted">
          No timeout
        </div>
      )}

      {/* Progress Bar */}
      {progress && progress.remaining > 0 && (
        <div className="mt-2">
          <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-500 dark:bg-purple-400 transition-all duration-100"
              style={{ width: `${progressPercent}%` }}
            ></div>
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(RemoteStartTriggerNode);
