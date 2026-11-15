import React from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { GAP, NODE_W, type GraphPlus } from "../../../../lib/treeGraphLayout";

const PlusButton: React.FC<{
  point: GraphPlus;
  hover: boolean;
  onOpen: (lane: GraphPlus["slot"]["lane"], index: number) => void;
}> = ({ point, hover, onOpen }) => {
  const { t } = useTranslation();
  return (
    <div
      // A hover zone covers the gap above a block; a disc stands on its own.
      className={cn(
        "absolute z-10 flex items-center justify-center",
        hover && "group/insert",
      )}
      style={
        hover
          ? {
              left: point.x - NODE_W / 2,
              top: point.y - GAP / 2,
              width: NODE_W,
              height: GAP,
            }
          : { left: point.x - 9, top: point.y - 9, width: 18, height: 18 }
      }
    >
      <button
        type="button"
        aria-label={point.label}
        title={
          hover ? t("scenarioRun.insertStepHere") : t("scenarioRun.addAStep")
        }
        onClick={() => onOpen(point.slot.lane, point.slot.index)}
        className={cn(
          "flex h-[18px] w-[18px] items-center justify-center rounded-full border bg-cx-card",
          hover
            ? "border-cx-border-strong text-cx-muted opacity-0 hover:border-cx-accent hover:text-cx-accent focus-visible:opacity-100 group-hover/insert:opacity-100"
            : "border-cx-accent text-cx-accent hover:bg-cx-accent hover:text-cx-card",
        )}
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
};

export default PlusButton;
