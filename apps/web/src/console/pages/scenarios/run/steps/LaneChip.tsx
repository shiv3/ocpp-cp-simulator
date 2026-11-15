import { useTranslation } from "react-i18next";
import React from "react";

import { cn } from "@/lib/utils";
import { laneHandle } from "../../../../lib/stepTree";
import type { LaneCondition } from "../../../../lib/blockTree";
import { laneLetter, laneStyle, type StepTreeViewProps } from "../stepVisuals";

const LaneChip: React.FC<{
  laneIndex: number;
  chip: string;
  open?: { forkId: string; condition: LaneCondition };
  number: (id: string) => number | null;
  onSelectLane: StepTreeViewProps["onSelectLane"];
}> = ({ laneIndex, chip, open, number, onSelectLane }) => {
  const { t } = useTranslation();
  const handle = open ? laneHandle(open.condition) : null;
  const label =
    onSelectLane && open && handle !== null
      ? t("scenarioRun.tree.openLane", {
          name: handle,
          n: number(open.forkId) ?? "",
        })
      : null;
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold",
          laneStyle(laneIndex).letter,
        )}
      >
        {laneLetter(laneIndex)}
      </span>
      {label !== null && open && handle !== null ? (
        <button
          type="button"
          data-lane-condition=""
          title={chip}
          aria-label={label}
          onClick={() => onSelectLane?.(open.forkId, handle)}
          className="min-w-0 max-w-full break-all rounded-md bg-cx-sub px-1.5 py-0.5 text-left font-mono text-[11px] text-cx-fg2 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden hover:text-cx-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-cx-accent"
        >
          {chip}
        </button>
      ) : (
        <span
          data-lane-condition=""
          title={chip}
          className="min-w-0 max-w-full break-all rounded-md bg-cx-sub px-1.5 py-0.5 font-mono text-[11px] text-cx-fg2 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden"
        >
          {chip}
        </span>
      )}
    </>
  );
};

export default LaneChip;
