import { useTranslation } from "react-i18next";
import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position, type Node } from "@xyflow/react";
import type { SwitchNodeData } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";
import BranchHandles from "./BranchHandles";

/** Schema 1.6 (#654): branches on a value. Edges leave from `case-<n>` or
 *  `default`. */
const SwitchNode: React.FC<NodeProps<Node<SwitchNodeData>>> = ({
  id,
  data,
  selected,
}) => {
  const { t } = useTranslation();
  const cases = Array.isArray(data.cases) ? data.cases : [];
  const value = JSON.stringify(data.value) ?? "";
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[220px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        {t("scenarioNodes.title.switch")}
      </div>
      <div className="text-sm font-mono text-primary truncate" title={value}>
        {value}
      </div>
      <BranchHandles
        nodeId={id}
        branches={[
          ...cases.map((c, index) => ({
            id: `case-${index}`,
            label: JSON.stringify(c) ?? "",
            title: `case-${index}: ${JSON.stringify(c) ?? ""}`,
          })),
          { id: "default", label: t("scenarioNodes.switch.default") },
        ]}
      />
    </div>
  );
};

export default memo(SwitchNode);
