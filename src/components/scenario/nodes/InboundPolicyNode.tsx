import React, { memo } from "react";
import { Handle, Position, NodeProps, type Node } from "@xyflow/react";
import { InboundPolicyNodeData } from "../../../cp/application/scenario/ScenarioTypes";

// Mapped type (not `extends`) so the result is a fresh object type that
// satisfies xyflow v12's `Node<Record<string, unknown>>` constraint — a
// plain interface does not.
type InboundPolicyNodeDataMapped = {
  [K in keyof InboundPolicyNodeData]: InboundPolicyNodeData[K];
};

type InboundPolicyFlowNode = Node<InboundPolicyNodeDataMapped>;

const InboundPolicyNode: React.FC<NodeProps<InboundPolicyFlowNode>> = ({
  data,
  selected,
}) => {
  const policyDesc =
    data.policy === "answer"
      ? "normal"
      : data.policy === "callerror"
        ? `error(${data.errorCode ?? "NotImplemented"})`
        : "ignore";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[200px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        Inbound Policy
      </div>
      <div className="text-sm font-bold text-purple-700 dark:text-purple-300">
        {data.action} → {policyDesc}
      </div>
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(InboundPolicyNode);
