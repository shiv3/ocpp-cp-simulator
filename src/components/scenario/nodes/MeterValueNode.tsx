import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { MeterValueNodeData } from "../../../cp/application/scenario/ScenarioTypes";

interface ExtendedMeterValueNodeData extends MeterValueNodeData {
  progress?: {
    remaining: number;
    total: number;
  };
  currentValue?: number;
}

function formatMeterReading(valueWh: number): string {
  if (valueWh >= 1000) {
    return `${(valueWh / 1000).toFixed(2)} kWh`;
  }
  return `${Math.round(valueWh)} Wh`;
}

const MeterValueNode: React.FC<NodeProps<ExtendedMeterValueNodeData>> = ({
  data,
  selected,
}) => {
  const progress = data.progress;
  const progressPercent = progress
    ? ((progress.total - progress.remaining) / progress.total) * 100
    : 0;
  const displayValue =
    data.currentValue !== undefined ? data.currentValue : data.value;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[180px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        Meter Value
      </div>
      <div className="flex items-center gap-2">
        <div className="text-2xl">⚡</div>
        <div className="flex-1">
          <div className="font-bold text-sm text-primary">
            {formatMeterReading(displayValue)}
          </div>
          <div className="text-xs text-muted">
            {data.sendMessage ? "Send message" : "Set value only"}
          </div>
        </div>
      </div>

      {data.autoIncrement && (
        <div className="text-xs text-green-700 dark:text-green-300 mt-1 font-semibold">
          ⚡ Auto +{data.incrementAmount || 1000}Wh /{" "}
          {data.incrementInterval || 10}s
          {progress && progress.remaining > 0 && (
            <span className="ml-1">({progress.remaining.toFixed(1)}s)</span>
          )}
        </div>
      )}

      {/* Progress Bar for Auto Increment */}
      {data.autoIncrement && progress && progress.remaining > 0 && (
        <div className="mt-2">
          <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 dark:bg-green-400 transition-all duration-100"
              style={{ width: `${progressPercent}%` }}
            ></div>
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(MeterValueNode);
