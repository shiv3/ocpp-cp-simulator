import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { useT } from "../../../i18n";
import { Handle, Position, type Node } from "@xyflow/react";
import type { CertQuirksNodeData } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";

type CertQuirksFlowNode = Node<CertQuirksNodeData>;

const CertQuirksNode: React.FC<NodeProps<CertQuirksFlowNode>> = ({
  data,
  selected,
}) => {
  const t = useT();
  // Compact summary of mode and key quirks for the node display
  const summary = (() => {
    if (data.mode === "clear") {
      return t("scenarioNodes.certQuirks.clearAll");
    }
    const parts: string[] = [];
    if (data.preset)
      parts.push(t("scenarioNodes.certQuirks.preset", { preset: data.preset }));
    if (data.csrKeyAlgorithm) parts.push(`CSR: ${data.csrKeyAlgorithm}`);
    if (data.csrPemLineEndings)
      parts.push(`PEM: ${data.csrPemLineEndings.toUpperCase()}`);
    return parts.length > 0
      ? parts.join(", ")
      : t("scenarioNodes.certQuirks.set");
  })();

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[200px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        {t("scenarioNodes.title.certQuirks")}
      </div>
      <div className="text-sm font-bold text-amber-700 dark:text-amber-300">
        {summary}
      </div>
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(CertQuirksNode);
