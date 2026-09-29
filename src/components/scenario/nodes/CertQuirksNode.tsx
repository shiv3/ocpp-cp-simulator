import React, { memo } from "react";
import { Handle, Position, NodeProps, type Node } from "@xyflow/react";
import { CertQuirksNodeData } from "../../../cp/application/scenario/ScenarioTypes";

type CertQuirksFlowNode = Node<CertQuirksNodeData>;

const CertQuirksNode: React.FC<NodeProps<CertQuirksFlowNode>> = ({
  data,
  selected,
}) => {
  // Compact summary of mode and key quirks for the node display
  const summary = (() => {
    if (data.mode === "clear") {
      return "clear all";
    }
    const parts: string[] = [];
    if (data.preset) parts.push(`${data.preset} preset`);
    if (data.csrKeyAlgorithm) parts.push(`CSR: ${data.csrKeyAlgorithm}`);
    if (data.csrPemLineEndings)
      parts.push(`PEM: ${data.csrPemLineEndings.toUpperCase()}`);
    return parts.length > 0 ? parts.join(", ") : "set";
  })();

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[200px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        Certificate Quirks
      </div>
      <div className="text-sm font-bold text-amber-700 dark:text-amber-300">
        {summary}
      </div>
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(CertQuirksNode);
