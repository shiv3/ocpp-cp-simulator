import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position, type Node } from "@xyflow/react";
import type { UseBehaviorNodeData } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";

/** Schema 1.5 (#566): uses a behavior loaded on the station. */
const UseBehaviorNode: React.FC<NodeProps<Node<UseBehaviorNodeData>>> = ({
  data,
  selected,
}) => {
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[220px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        Use Behavior
      </div>
      <div
        className="text-sm font-mono text-primary truncate"
        title={data.behaviorId}
      >
        {data.behaviorId}
      </div>
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(UseBehaviorNode);
