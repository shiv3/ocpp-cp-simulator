import React from "react";
import { useTranslation } from "react-i18next";
import { LogOut, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { TAG_H, type TreeGraphGeometry } from "../../../../lib/treeGraphLayout";
import type { Capability } from "../../../../lib/blockTree";
import { laneLetter, laneStyle, type StepTreeViewProps } from "../stepVisuals";

const LaneTags: React.FC<{
  geometry: TreeGraphGeometry;
  editable: boolean;
  dragging: boolean;
  laneCaps: ReadonlyMap<string, Capability> | undefined;
  numbers: ReadonlyMap<string, number | string>;
  capTitle: (cap: Capability, label: string) => string;
  onRemoveLane: StepTreeViewProps["onRemoveLane"];
  onSelectLane: StepTreeViewProps["onSelectLane"];
}> = ({
  geometry,
  editable,
  dragging,
  laneCaps,
  numbers,
  capTitle,
  onRemoveLane,
  onSelectLane,
}) => {
  const { t } = useTranslation();
  const drag = dragging;
  return (
    <>
      {geometry.tags.map((tag) => {
        const removeCap =
          editable && onRemoveLane ? (laneCaps?.get(tag.key) ?? null) : null;
        const removeLabel = t("scenarioRun.tree.removeLane", {
          lane: laneLetter(tag.laneIndex),
        });
        const tip = [
          tag.text,
          tag.dead
            ? t("scenarioRun.tree.deadLane")
            : tag.leaves
              ? t("scenarioRun.tree.leavesLoop")
              : null,
        ]
          .filter(Boolean)
          .join(" — ");
        const openLabel =
          onSelectLane && tag.handle !== null
            ? t("scenarioRun.tree.openLane", {
                name: tag.handle,
                n: numbers.get(tag.forkId) ?? "",
              })
            : null;
        return (
          <div
            key={tag.key}
            data-testid="lane-tag"
            data-lane={tag.laneIndex}
            data-fork={tag.forkId}
            data-dead-lane={tag.dead ? "" : undefined}
            data-leaves-loop={tag.leaves ? "" : undefined}
            title={
              tag.dead
                ? t("scenarioRun.tree.deadLane")
                : tag.leaves
                  ? t("scenarioRun.tree.leavesLoop")
                  : undefined
            }
            className={cn(
              "absolute z-[5] flex items-center gap-1.5 rounded-full border bg-cx-card px-1 text-xs",
              tag.dead
                ? "border-dashed border-cx-border-strong opacity-60"
                : "border-cx-border",
            )}
            style={{
              left: tag.x - tag.w / 2,
              top: tag.y,
              width: tag.w,
              height: TAG_H,
            }}
          >
            <span
              aria-hidden
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                laneStyle(tag.laneIndex).letter,
              )}
            >
              {laneLetter(tag.laneIndex)}
            </span>
            {openLabel && tag.handle !== null ? (
              <button
                type="button"
                data-lane-condition=""
                aria-label={openLabel}
                title={tip}
                onClick={() => onSelectLane?.(tag.forkId, tag.handle!)}
                className="min-w-0 flex-1 truncate rounded text-left font-mono text-[11px] text-cx-fg2 hover:text-cx-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-cx-accent"
              >
                {tag.text}
              </button>
            ) : (
              <span
                data-lane-condition=""
                title={tip}
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-cx-fg2"
              >
                {tag.text}
              </span>
            )}
            {tag.leaves && (
              <LogOut className="h-3 w-3 shrink-0 text-cx-purple" aria-hidden />
            )}
            <span className="shrink-0 font-mono text-[10px] text-cx-muted">
              {tag.count}
            </span>
            {removeCap && !drag && (
              <button
                type="button"
                aria-label={removeLabel}
                title={capTitle(removeCap, removeLabel)}
                disabled={!removeCap.ok}
                onClick={() => onRemoveLane?.(tag.forkId, tag.laneIndex)}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-cx-faint hover:bg-cx-rose/10 hover:text-cx-rose disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-cx-faint"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
    </>
  );
};

export default LaneTags;
