import { useTranslation } from "react-i18next";
import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position, type Node } from "@xyflow/react";
import type { CsmsCallTriggerNodeData } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

type CsmsCallTriggerNodeDataWithProgress = CsmsCallTriggerNodeData & {
  progress?: {
    remaining: number;
    total: number;
  };
};

type CsmsCallTriggerFlowNode = Node<CsmsCallTriggerNodeDataWithProgress>;

const CsmsCallTriggerNode: React.FC<NodeProps<CsmsCallTriggerFlowNode>> = ({
  data,
  selected,
}) => {
  const { t } = useTranslation();
  const progress = data.progress;
  const progressPercent = progress
    ? ((progress.total - progress.remaining) / progress.total) * 100
    : 0;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-purple-50 dark:bg-purple-900 min-w-[180px] ${
        selected
          ? "border-blue-500"
          : "border-purple-400 dark:border-purple-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-purple-700 dark:text-purple-300 mb-1">
        {t("scenarioNodes.title.csmsCallTrigger")}
      </div>
      <div className="font-bold text-sm text-primary mb-1">{data.label}</div>
      <div className="text-xs text-muted mb-1">
        {t("scenarioNodes.waitsFor", { value: data.action })}
      </div>
      {data.timeout !== undefined && data.timeout > 0 && (
        <div className="text-xs text-muted">
          {t("scenarioNodes.timeout", { seconds: data.timeout })}
          {progress && progress.remaining > 0 && (
            <span className="ml-1 text-purple-700 dark:text-purple-300 font-semibold">
              {t("scenarioNodes.secondsLeft", {
                seconds: progress.remaining.toFixed(1),
              })}
            </span>
          )}
        </div>
      )}
      {(!data.timeout || data.timeout === 0) && (
        <div className="text-xs text-muted">{t("scenarioNodes.noTimeout")}</div>
      )}

      {progress && progress.remaining > 0 && (
        <div className="mt-2">
          <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-500 dark:bg-purple-400 transition-all duration-100"
              style={{ width: `${progressPercent}%` }}
            ></div>
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(CsmsCallTriggerNode);
