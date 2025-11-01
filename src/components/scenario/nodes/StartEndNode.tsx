import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { BaseNodeData } from "../../../cp/application/scenario/ScenarioTypes";

interface StartEndNodeProps extends NodeProps<BaseNodeData> {
  nodeType: "start" | "end";
}

const StartEndNode: React.FC<StartEndNodeProps> = ({ selected, nodeType }) => {
  const isStart = nodeType === "start";
  const bgColor = isStart
    ? "bg-green-100 dark:bg-green-900"
    : "bg-red-100 dark:bg-red-900";
  const borderColor = isStart ? "border-green-500" : "border-red-500";
  const textColor = isStart
    ? "text-green-700 dark:text-green-300"
    : "text-red-700 dark:text-red-300";

  return (
    <div
      className={`px-6 py-4 rounded-full border-2 ${bgColor} min-w-[120px] ${
        selected ? "border-blue-500" : borderColor
      }`}
    >
      {!isStart && (
        <Handle type="target" position={Position.Top} className="w-3 h-3" />
      )}

      <div className={`text-center font-bold ${textColor}`}>
        {isStart ? "🟢 Start" : "🔴 End"}
      </div>

      {isStart && (
        <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
      )}
    </div>
  );
};

export default memo(StartEndNode);
