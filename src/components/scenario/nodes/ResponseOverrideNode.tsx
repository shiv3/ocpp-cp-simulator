import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { ResponseOverrideNodeData } from "../../../cp/application/scenario/ScenarioTypes";

const ResponseOverrideNode: React.FC<NodeProps<ResponseOverrideNodeData>> = ({
  data,
  selected,
}) => {
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[200px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        Response Override
      </div>
      <div className="text-sm font-bold text-amber-700 dark:text-amber-300">
        {data.action} → {data.status}
      </div>
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(ResponseOverrideNode);
