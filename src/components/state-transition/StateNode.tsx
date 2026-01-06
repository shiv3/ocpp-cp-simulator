import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";

interface StateNodeData {
  status: OCPPStatus;
  label: string;
  isCurrent: boolean;
  isOperative: boolean;
}

const StateNode: React.FC<NodeProps<StateNodeData>> = ({ data }) => {
  const { status, label, isCurrent, isOperative } = data;

  // Color settings based on state
  const getBackgroundColor = () => {
    if (isCurrent) {
      return "bg-blue-500 border-blue-700";
    }
    if (!isOperative) {
      return "bg-gray-400 border-gray-600";
    }
    switch (status) {
      case OCPPStatus.Available:
        return "bg-green-400 border-green-600";
      case OCPPStatus.Preparing:
        return "bg-yellow-400 border-yellow-600";
      case OCPPStatus.Charging:
        return "bg-emerald-500 border-emerald-700";
      case OCPPStatus.SuspendedEV:
      case OCPPStatus.SuspendedEVSE:
        return "bg-orange-400 border-orange-600";
      case OCPPStatus.Finishing:
        return "bg-cyan-400 border-cyan-600";
      case OCPPStatus.Reserved:
        return "bg-purple-400 border-purple-600";
      case OCPPStatus.Unavailable:
        return "bg-gray-500 border-gray-700";
      case OCPPStatus.Faulted:
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

export default memo(StateNode);
