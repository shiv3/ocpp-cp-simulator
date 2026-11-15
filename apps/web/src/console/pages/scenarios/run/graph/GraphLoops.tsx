import React from "react";
import { useTranslation } from "react-i18next";
import { Repeat, RepeatOff, SlidersHorizontal } from "lucide-react";

import type { Capability } from "../../../../lib/blockTree";
import type { TreeGraphGeometry } from "../../../../lib/treeGraphLayout";
import { LoopBoundsPanel, LoopBoundsSummary } from "../loopBoundsUi";
import type { StepTreeViewProps } from "../stepVisuals";
import { BOUNDS_PANEL_H, WAIT_TYPES, revealBounds } from "./graphShared";

/** The labels, "Bounds" / "Stop repeating" buttons and bounds editors of
 *  every loop of the graph. */
const GraphLoops: React.FC<{
  geometry: TreeGraphGeometry;
  height: number;
  dragging: boolean;
  openBounds: string | null;
  setOpenBounds: React.Dispatch<React.SetStateAction<string | null>>;
  unwrapCaps: ReadonlyMap<string, Capability> | undefined;
  loopBounds: StepTreeViewProps["loopBounds"];
  onUnwrapLoop: StepTreeViewProps["onUnwrapLoop"];
}> = ({
  geometry,
  height,
  dragging,
  openBounds,
  setOpenBounds,
  unwrapCaps,
  loopBounds,
  onUnwrapLoop,
}) => {
  const { t } = useTranslation();
  const { cards } = geometry;
  const drag = dragging;
  return (
    <>
      {geometry.loops.map((loop) => {
        const canExit = loop.canExit;
        const boundsOpen = openBounds === loop.headerId;
        const header = cards.find((c) => c.node.id === loop.headerId);
        const waits = WAIT_TYPES.has(header?.node.type ?? "");
        const unwrapCap =
          onUnwrapLoop && !drag ? unwrapCaps?.get(loop.headerId) : undefined;
        // The loop's label (its bounds, for a loop edge), then "Bounds"
        // and "Stop repeating" right after it (the label truncates
        // first), all inside the rectangle; the bounds editor opens
        // below it.
        return (
          <React.Fragment key={`label:${loop.key}`}>
            <div
              className="absolute flex items-center gap-2 whitespace-nowrap text-xs"
              style={{
                left: loop.label.x,
                top: loop.label.y - 1,
                maxWidth: loop.rect.x + loop.rect.w - loop.label.x - 6,
              }}
            >
              <div
                data-loop-block=""
                data-loop-to={loop.headerId}
                aria-label={t("scenarioRun.loopSteps", {
                  from: loop.from,
                  to: loop.to,
                })}
                title={t(
                  canExit
                    ? "scenarioRun.loopUntilExit"
                    : "scenarioRun.loopUntilRunStops",
                )}
                className="flex min-w-0 items-center gap-1.5 overflow-hidden"
              >
                <Repeat
                  className="h-3.5 w-3.5 shrink-0 text-cx-purple"
                  aria-hidden
                />
                {loop.loopEdge ? (
                  <LoopBoundsSummary
                    loop={loop}
                    className="min-w-0 truncate font-semibold text-cx-purple"
                  />
                ) : (
                  <span className="min-w-0 truncate font-semibold text-cx-purple">
                    {t(
                      canExit
                        ? "scenarioRun.loopRepeat"
                        : "scenarioRun.loopForever",
                    )}
                  </span>
                )}
                {waits && (
                  <span className="min-w-0 shrink-[1000] truncate text-cx-muted">
                    · {t("scenarioRun.loopWaitsAt", { n: loop.from })}
                  </span>
                )}
              </div>
            </div>
            <div
              className="absolute flex items-center gap-2 whitespace-nowrap text-xs"
              style={{ left: loop.label.x, top: loop.label.y + 21 }}
            >
              {loopBounds && !drag && (
                <button
                  type="button"
                  data-testid="edit-loop-bounds"
                  data-loop={loop.headerId}
                  aria-expanded={boundsOpen}
                  title={t("scenarioRun.loopBounds.editHint")}
                  onClick={() =>
                    setOpenBounds(boundsOpen ? null : loop.headerId)
                  }
                  className="z-10 flex h-[18px] shrink-0 items-center gap-1 rounded border border-cx-purple/40 px-1.5 font-medium text-cx-purple hover:bg-cx-purple/15"
                >
                  <SlidersHorizontal
                    className="h-3.5 w-3.5 shrink-0"
                    aria-hidden
                  />
                  {t("scenarioRun.loopBounds.edit")}
                </button>
              )}
              {unwrapCap && (
                <button
                  type="button"
                  data-testid="unwrap-loop"
                  data-loop={loop.headerId}
                  title={
                    unwrapCap.ok
                      ? t("scenarios.editor.unwrapLoopHint")
                      : t(unwrapCap.reason)
                  }
                  disabled={!unwrapCap.ok}
                  onClick={() => onUnwrapLoop?.(loop.headerId)}
                  className="z-10 flex h-[18px] shrink-0 items-center gap-1 rounded border border-cx-purple/40 px-1.5 font-medium text-cx-purple hover:bg-cx-purple/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RepeatOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {t("scenarios.editor.unwrapLoop")}
                </button>
              )}
            </div>
            {boundsOpen && loopBounds && (
              <div
                ref={revealBounds}
                className="absolute z-20 w-[340px]"
                style={
                  // Near the canvas bottom: open upward, over the loop.
                  loop.label.y + 22 + BOUNDS_PANEL_H > height
                    ? {
                        left: loop.label.x,
                        bottom: Math.max(0, height - loop.label.y + 4),
                      }
                    : { left: loop.label.x, top: loop.label.y + 44 }
                }
              >
                <LoopBoundsPanel
                  loop={loop}
                  editing={loopBounds}
                  onClose={() => setOpenBounds(null)}
                />
              </div>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
};

export default GraphLoops;
