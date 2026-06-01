import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { DataTransferNodeData } from "../../../cp/application/scenario/ScenarioTypes";

/**
 * §4.3 CP-initiated DataTransfer.req. The vendor / message id / payload
 * semantics are entirely vendor-specific.
 */
const DataTransferNode: React.FC<NodeProps<DataTransferNodeData>> = ({
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
      <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">
        DataTransfer (§4.3)
      </div>
      <div
        className="text-sm font-mono text-primary truncate"
        title={data.vendorId}
      >
        {data.vendorId}
      </div>
      {data.messageId && (
        <div
          className="text-xs text-muted font-mono truncate"
          title={data.messageId}
        >
          msgId: {data.messageId}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(DataTransferNode);
