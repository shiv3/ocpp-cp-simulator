import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { ConnectorPlugNodeData } from "../../../cp/application/scenario/ScenarioTypes";

const ConnectorPlugNode: React.FC<NodeProps<ConnectorPlugNodeData>> = ({ data, selected }) => {
  const actionIcon = data.action === "plugin" ? "🔌" : "🔓";
  const actionText = data.action === "plugin" ? "Plug In" : "Plug Out";
  const actionColor = data.action === "plugin" ? "text-green-600" : "text-red-600";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[180px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">
        Connector Plug
      </div>
      <div className="flex items-center gap-2">
        <div className="text-2xl">{actionIcon}</div>
        <div>
          <div className={`font-bold text-sm ${actionColor}`}>{actionText}</div>
          <div className="text-xs text-muted">Cable action</div>
        </div>
      </div>
      {data.description && (
        <div className="text-xs text-muted mt-1">{data.description}</div>
      )}

      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(ConnectorPlugNode);
