import { useTranslation } from "react-i18next";
import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position, type Node } from "@xyflow/react";
import type { ResponseOverrideNodeData } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";

type ResponseOverrideFlowNode = Node<ResponseOverrideNodeData>;

const ResponseOverrideNode: React.FC<NodeProps<ResponseOverrideFlowNode>> = ({
  data,
  selected,
}) => {
  const { t } = useTranslation();
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[200px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        {t("scenarioNodes.title.responseOverride")}
      </div>
      <div className="text-sm font-bold text-amber-700 dark:text-amber-300">
        {data.action} → {data.status}
      </div>
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(ResponseOverrideNode);
