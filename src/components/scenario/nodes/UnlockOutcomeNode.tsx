import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { UnlockOutcomeNodeData } from "../../../cp/application/scenario/ScenarioTypes";

/**
 * §5.18 / §7.46: pre-arm the connector's next UnlockConnector.req response.
 * Does not emit any CSMS-bound message itself.
 */
const UnlockOutcomeNode: React.FC<NodeProps<UnlockOutcomeNodeData>> = ({
  data,
  selected,
}) => {
  const tint =
    data.outcome === "Unlocked"
      ? "text-green-700 dark:text-green-300"
      : data.outcome === "UnlockFailed"
        ? "text-amber-700 dark:text-amber-300"
        : "text-gray-700 dark:text-gray-300";
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[200px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        Unlock Outcome (§5.18)
      </div>
      <div className={`text-sm font-bold ${tint}`}>{data.outcome}</div>
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(UnlockOutcomeNode);
