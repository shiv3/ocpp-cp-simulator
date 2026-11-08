import { useTranslation } from "react-i18next";
import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position, type Node } from "@xyflow/react";
import type { CallResponseNodeData } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";

/**
 * Schema 1.5 (#566): answers the CALL taken by the nearest replacing
 * csmsCallTrigger of the branch.
 */
const CallResponseNode: React.FC<NodeProps<Node<CallResponseNodeData>>> = ({
  data,
  selected,
}) => {
  const { t } = useTranslation();
  const summary =
    data.kind === "error"
      ? `CALLERROR ${data.errorCode ?? "GenericError"}`
      : data.kind === "none"
        ? t("scenarioNodes.callResponse.noAnswer")
        : "CALLRESULT";
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[220px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        {t("scenarioNodes.title.callResponse")}
      </div>
      <div className="text-sm font-mono text-primary truncate" title={summary}>
        {summary}
      </div>
      {data.skipValidation && (
        <div className="text-xs text-muted">
          {t("scenarioNodes.ocppCall.unvalidated")}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(CallResponseNode);
