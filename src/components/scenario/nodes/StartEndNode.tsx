import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import {
  BaseNodeData,
  StartNodeData,
} from "../../../cp/application/scenario/ScenarioTypes";

interface StartEndNodeProps extends NodeProps<BaseNodeData> {
  nodeType: "start" | "end";
}

const StartEndNode: React.FC<StartEndNodeProps> = ({
  data,
  selected,
  nodeType,
}) => {
  const isStart = nodeType === "start";
  const bgColor = isStart
    ? "bg-green-100 dark:bg-green-900"
    : "bg-red-100 dark:bg-red-900";
  const borderColor = isStart ? "border-green-500" : "border-red-500";
  const textColor = isStart
    ? "text-green-700 dark:text-green-300"
    : "text-red-700 dark:text-red-300";

  // Show the Start trigger config inline so the operator sees at a glance
  // what fires the scenario without opening the config panel. Missing
  // `triggerOn` defaults to "connect" (matches the auto-start gate).
  const startData = isStart ? (data as StartNodeData | undefined) : undefined;
  const triggerOn = startData?.triggerOn ?? "connect";
  const triggerLabel =
    triggerOn === "status"
      ? `on ${startData?.targetStatus ?? "<status>"}`
      : "on connect";

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
        <div className={`text-center text-xs mt-0.5 ${textColor}`}>
          {triggerLabel}
        </div>
      )}

      {isStart && (
        <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
      )}
    </div>
  );
};

export default memo(StartEndNode);
