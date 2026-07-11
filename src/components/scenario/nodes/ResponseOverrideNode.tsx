import React, { memo } from "react";
import { Handle, Position, NodeProps, type Node } from "@xyflow/react";
import { ResponseOverrideNodeData } from "../../../cp/application/scenario/ScenarioTypes";

// Mapped type (not `extends`) so the result is a fresh object type that
// satisfies xyflow v12's `Node<Record<string, unknown>>` constraint — a
// plain interface does not.
type ResponseOverrideNodeDataMapped = {
  [K in keyof ResponseOverrideNodeData]: ResponseOverrideNodeData[K];
};

type ResponseOverrideFlowNode = Node<ResponseOverrideNodeDataMapped>;

const ResponseOverrideNode: React.FC<NodeProps<ResponseOverrideFlowNode>> = ({
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
