import React, { memo } from "react";
import { Handle, Position, NodeProps, type Node } from "@xyflow/react";
import { OcppCallNodeData } from "../../../cp/application/scenario/ScenarioTypes";

/**
 * #389 expert OCPP call: any station-initiated CALL with an authored payload.
 */
const OcppCallNode: React.FC<NodeProps<Node<OcppCallNodeData>>> = ({
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
        OCPP Call (expert)
      </div>
      <div
        className="text-sm font-mono text-primary truncate"
        title={data.action}
      >
        {data.action}
      </div>
      {(data.skipValidation || data.applyResponse) && (
        <div className="text-xs text-muted">
          {[
            data.skipValidation && "unvalidated",
            data.applyResponse && "applies answer",
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(OcppCallNode);
