import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { RemoteStopTriggerNodeData } from "../../../cp/application/scenario/ScenarioTypes";

interface ExtendedRemoteStopTriggerNodeData extends RemoteStopTriggerNodeData {
  progress?: {
    remaining: number;
    total: number;
  };
}

// Stop-side counterpart of RemoteStartTriggerNode. Visually mirrors the
// purple Trigger card so the pair reads as a matched set in the editor;
// label and copy are the only deltas.
const RemoteStopTriggerNode: React.FC<
  NodeProps<ExtendedRemoteStopTriggerNodeData>
> = ({ data, selected }) => {
  const progress = data.progress;
  const progressPercent = progress
    ? ((progress.total - progress.remaining) / progress.total) * 100
    : 0;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-purple-50 dark:bg-purple-900 min-w-[180px] ${
        selected
          ? "border-blue-500"
          : "border-purple-400 dark:border-purple-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-purple-700 dark:text-purple-300 mb-1">
        Remote Stop Trigger
      </div>
      <div className="font-bold text-sm text-primary mb-1">{data.label}</div>
      {data.timeout !== undefined && data.timeout > 0 && (
        <div className="text-xs text-muted">
          Timeout: {data.timeout}s
          {progress && progress.remaining > 0 && (
            <span className="ml-1 text-purple-700 dark:text-purple-300 font-semibold">
              ({progress.remaining.toFixed(1)}s left)
            </span>
          )}
        </div>
      )}
      {(!data.timeout || data.timeout === 0) && (
        <div className="text-xs text-muted">No timeout</div>
      )}

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

export default memo(RemoteStopTriggerNode);
