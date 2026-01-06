import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";

export type ScenarioState = "idle" | "running" | "paused" | "waiting" | "stepping" | "completed" | "error";

interface ScenarioStateNodeData {
  state: ScenarioState;
  label: string;
  isCurrent: boolean;
}

const ScenarioStateNode: React.FC<NodeProps<ScenarioStateNodeData>> = ({ data }) => {
  const { state, label, isCurrent } = data;

  // Color settings based on state
  const getBackgroundColor = () => {
    if (isCurrent) {
      return "bg-blue-500 border-blue-700";
    }
    switch (state) {
      case "idle":
        return "bg-gray-400 border-gray-600";
      case "running":
        return "bg-green-500 border-green-700";
      case "paused":
        return "bg-yellow-500 border-yellow-700";
      case "waiting":
        return "bg-orange-500 border-orange-700";
      case "stepping":
        return "bg-purple-500 border-purple-700";
      case "completed":
        return "bg-emerald-500 border-emerald-700";
      case "error":
        return "bg-red-500 border-red-700";
      default:
        return "bg-gray-300 border-gray-500";
    }
  };

  return (
    <div
      className={`px-4 py-2 shadow-lg rounded-lg border-2 ${getBackgroundColor()} ${
        isCurrent ? "ring-4 ring-blue-300 animate-pulse" : ""
      }`}
      style={{ opacity: isCurrent ? 1 : 0.4 }}
    >
      {/* Top handle */}
      <Handle
        type="target"
        id="top"
        position={Position.Top}
        className="w-3 h-3 !bg-gray-600"
      />
      <Handle
        type="source"
        id="top-source"
        position={Position.Top}
        className="w-3 h-3 !bg-gray-600"
      />

      {/* Node content */}
      <div className="flex flex-col items-center">
        <div className="text-sm font-bold text-white drop-shadow-md">
          {label}
        </div>
        {isCurrent && (
          <div className="mt-1 text-xs text-white font-semibold">
            ● Current
          </div>
        )}
      </div>

      {/* Bottom handle */}
      <Handle
        type="source"
        id="bottom"
        position={Position.Bottom}
        className="w-3 h-3 !bg-gray-600"
      />
      <Handle
        type="target"
        id="bottom-target"
        position={Position.Bottom}
        className="w-3 h-3 !bg-gray-600"
      />

      {/* Left handle */}
      <Handle
        type="target"
        id="left"
        position={Position.Left}
        className="w-3 h-3 !bg-gray-600"
      />
      <Handle
        type="source"
        id="left-source"
        position={Position.Left}
        className="w-3 h-3 !bg-gray-600"
      />

      {/* Right handle */}
      <Handle
        type="source"
        id="right"
        position={Position.Right}
        className="w-3 h-3 !bg-gray-600"
      />
      <Handle
        type="target"
        id="right-target"
        position={Position.Right}
        className="w-3 h-3 !bg-gray-600"
      />
    </div>
  );
};

export default memo(ScenarioStateNode);
