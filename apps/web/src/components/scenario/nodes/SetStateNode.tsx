import { useTranslation } from "react-i18next";
import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position, type Node } from "@xyflow/react";
import type { SetStateNodeData } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";

/** Schema 1.6 (#654): stores a value in the run's state. */
const SetStateNode: React.FC<NodeProps<Node<SetStateNodeData>>> = ({
  data,
  selected,
}) => {
  const { t } = useTranslation();
  const value = JSON.stringify(data.value) ?? "";
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[200px] max-w-[260px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        {t("scenarioNodes.title.setState")}
      </div>
      <div className="text-sm font-mono text-primary truncate" title={value}>
        {data.key} = {value}
      </div>
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(SetStateNode);
