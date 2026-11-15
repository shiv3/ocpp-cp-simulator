import { useTranslation } from "react-i18next";
import React from "react";
import { ArrowDown, GitMerge } from "lucide-react";

import type { ForkBlock } from "../../../../lib/blockTree";

const MergeFooter: React.FC<{
  fork: ForkBlock;
  loopHeader: string | null;
  number: (id: string) => number | null;
}> = ({ fork, loopHeader, number }) => {
  const { t } = useTranslation();
  const merge = fork.merge;
  // Lanes that meet at their loop's first step: the block's back arm
  // says where they go.
  if (!merge || merge.nodeId === loopHeader) return null;
  if (merge.kind === "join") {
    return (
      <p
        data-join={merge.nodeId}
        className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-cx-sub px-2 py-0.5 text-xs text-cx-fg2"
      >
        <GitMerge className="h-3.5 w-3.5" aria-hidden />
        {t("scenarioRun.tree.join", { mode: merge.mode })}
      </p>
    );
  }
  const n = number(merge.nodeId);
  return (
    <p
      data-merge={merge.nodeId}
      className="mt-2 flex items-center gap-1.5 text-xs text-cx-muted"
    >
      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
      {n !== null
        ? t("scenarioRun.tree.continuesAt", { n })
        : t("scenarioRun.tree.continuesAtEnd")}
    </p>
  );
};

export default MergeFooter;
