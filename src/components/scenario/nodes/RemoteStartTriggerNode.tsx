import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { RemoteStartTriggerNodeData } from "../../../cp/application/scenario/ScenarioTypes";

const RemoteStartTriggerNode: React.FC<NodeProps<RemoteStartTriggerNodeData>> = ({
  data,
  selected,
}) => {
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
        </div>
      )}
      {(!data.timeout || data.timeout === 0) && (
        <div className="text-xs text-muted">
          No timeout
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(RemoteStartTriggerNode);
