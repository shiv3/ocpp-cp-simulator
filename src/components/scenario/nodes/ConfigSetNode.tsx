import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { ConfigSetNodeData } from "../../../cp/application/scenario/ScenarioTypes";

/**
 * Applies a Configuration key change locally via the ConfigurationStore.
 * Mirrors ChangeConfiguration.req semantics (§5.3) — useful for tightening
 * MeterValueSampleInterval / changing MeterValuesSampledData mid-scenario.
 */
const ConfigSetNode: React.FC<NodeProps<ConfigSetNodeData>> = ({
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
        ChangeConfiguration (§5.3)
      </div>
      <div className="text-sm font-mono text-primary truncate" title={data.key}>
        {data.key}
      </div>
      <div className="text-xs text-muted font-mono truncate" title={data.value}>
        = {data.value}
      </div>
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(ConfigSetNode);
