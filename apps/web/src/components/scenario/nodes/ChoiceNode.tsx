import { useTranslation } from "react-i18next";
import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position, type Node } from "@xyflow/react";
import type { ChoiceNodeData } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";
import BranchHandles from "./BranchHandles";

/** Schema 1.6 (#654): a seeded, weighted draw. Edges leave from
 *  `option-<n>`. */
const ChoiceNode: React.FC<NodeProps<Node<ChoiceNodeData>>> = ({
  id,
  data,
  selected,
}) => {
  const { t } = useTranslation();
  const options = Array.isArray(data.options) ? data.options : [];
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[220px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        {t("scenarioNodes.title.choice")}
      </div>
      <div className="text-xs text-secondary">
        {t("scenarioNodes.choice.options", { count: options.length })}
      </div>
      <BranchHandles
        nodeId={id}
        branches={options.map((option, index) => ({
          id: `option-${index}`,
          label: option.label || `${index}`,
          title: `option-${index} (${option.weight ?? 1})`,
        }))}
      />
    </div>
  );
};

export default memo(ChoiceNode);
