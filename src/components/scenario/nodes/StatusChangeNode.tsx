import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { StatusChangeNodeData } from "../../../cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";

const StatusChangeNode: React.FC<NodeProps<StatusChangeNodeData>> = ({ data, selected }) => {
  const statusColor = (status: OCPPStatus) => {
    switch (status) {
      case OCPPStatus.Available:
        return "bg-green-500";
      case OCPPStatus.Charging:
        return "bg-blue-500";
      case OCPPStatus.Unavailable:
        return "bg-gray-500";
      case OCPPStatus.Faulted:
        return "bg-red-500";
      default:
        return "bg-yellow-500";
    }
  };

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[180px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">
        Status Change
      </div>
      <div className="flex items-center gap-2">
        <div className={`w-3 h-3 rounded-full ${statusColor(data.status)}`}></div>
        <div className="font-bold text-sm text-primary">{data.status}</div>
      </div>
      {data.description && (
        <div className="text-xs text-muted mt-1">{data.description}</div>
      )}

      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(StatusChangeNode);
