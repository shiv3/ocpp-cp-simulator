import { useTranslation } from "react-i18next";
import React from "react";
import {
  CornerLeftUp,
  Repeat,
  RepeatOff,
  SlidersHorizontal,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  Capability,
  LoopBlock as LoopBlockModel,
} from "../../../../lib/blockTree";
import {
  LoopBoundsPanel,
  LoopBoundsSummary,
  type LoopBoundsEditing,
} from "../loopBoundsUi";

/**
 * A loop drawn as Scratch draws "forever": a C-shaped block whose top arm
 * says it repeats, whose left spine holds the repeated steps (`children`,
 * a list of boxes), and whose bottom arm says where the run goes back to.
 * The back edge is unconditional, so the loop repeats until the run ends,
 * unless a switch or choice inside picks a handle with no edge (`canExit`):
 * then the top arm says "Repeat", not "Repeat forever". A loop edge
 * (schema 1.10) says its bounds instead: "Repeat 3 times / for 2 h / until
 * … (whichever first)"; the editor's "Bounds" button edits them inline.
 * The arms and the spine are tints over whatever is behind them, so the
 * block reads the same on a page, a card or a panel, in either theme.
 */
const LoopBlock: React.FC<{
  /** The loop (its bounds, when it has a loop edge). */
  loop: LoopBlockModel;
  /** The step the loop goes back to (its first step). */
  target: string;
  /** Box numbers of the first and last repeated step. */
  from: number;
  to: number;
  /** The first repeated step waits (a delay or a trigger). */
  waitsFirst: boolean;
  /** A repeated step may end the branch (a switch or choice). */
  canExit: boolean;
  /** A step inside is the run's current step. */
  active: boolean;
  /** The loop is block `blockIndex` of its lane (what a drag measures). */
  blockIndex?: number;
  /** editable: the "Stop repeating" button and whether it applies. */
  unwrap?: { cap: Capability; onClick: () => void };
  /** editable: the "Bounds" button and its inline editor. */
  bounds?: LoopBoundsEditing;
  children: React.ReactNode;
}> = ({
  loop,
  target,
  from,
  to,
  waitsFirst,
  canExit,
  active,
  blockIndex,
  unwrap,
  bounds,
  children,
}) => {
  const { t } = useTranslation();
  const labelId = React.useId();
  const [editingBounds, setEditingBounds] = React.useState(false);
  const tint = active ? "bg-cx-purple/20" : "bg-cx-purple/12";
  return (
    <li
      data-loop-block=""
      data-block={blockIndex}
      data-loop-to={target}
      aria-label={t("scenarioRun.loopSteps", { from, to })}
      className="min-w-0"
    >
      <div
        className={cn(
          "flex min-h-7 flex-wrap items-center gap-x-1.5 rounded-t-[12px] rounded-br-[12px] px-2.5 py-1 text-xs",
          tint,
        )}
      >
        <span
          id={labelId}
          title={t(
            canExit
              ? "scenarioRun.loopUntilExit"
              : "scenarioRun.loopUntilRunStops",
          )}
          className="inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-cx-purple"
        >
          <Repeat className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {loop.loopEdge ? (
            <LoopBoundsSummary loop={loop} className="whitespace-normal" />
          ) : (
            t(canExit ? "scenarioRun.loopRepeat" : "scenarioRun.loopForever")
          )}
        </span>
        {waitsFirst && (
          <span className="text-cx-muted">
            · {t("scenarioRun.loopWaitsAt", { n: from })}
          </span>
        )}
        {bounds && (
          <button
            type="button"
            data-testid="edit-loop-bounds"
            aria-expanded={editingBounds}
            title={t("scenarioRun.loopBounds.editHint")}
            onClick={() => setEditingBounds((open) => !open)}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-cx-purple hover:bg-cx-purple/15"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
            {t("scenarioRun.loopBounds.edit")}
          </button>
        )}
        {unwrap && (
          <button
            type="button"
            data-testid="unwrap-loop"
            title={
              unwrap.cap.ok
                ? t("scenarios.editor.unwrapLoopHint")
                : t(unwrap.cap.reason)
            }
            disabled={!unwrap.cap.ok}
            onClick={unwrap.onClick}
            className={cn(
              !bounds && "ml-auto",
              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-cx-purple hover:bg-cx-purple/15 disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            <RepeatOff className="h-3.5 w-3.5" aria-hidden />
            {t("scenarios.editor.unwrapLoop")}
          </button>
        )}
      </div>
      {bounds && editingBounds && (
        <div className={cn("px-2.5 pb-2", tint)}>
          <LoopBoundsPanel
            loop={loop}
            editing={bounds}
            onClose={() => setEditingBounds(false)}
          />
        </div>
      )}
      <div className="flex">
        <div aria-hidden className={cn("w-3 shrink-0", tint)} />
        <div
          role="group"
          aria-labelledby={labelId}
          className="min-w-0 flex-1 py-1.5 pl-1.5"
        >
          {children}
        </div>
      </div>
      <div
        className={cn(
          "flex min-h-6 items-center gap-1.5 rounded-b-[12px] rounded-tr-[12px] px-2.5 py-1 text-xs text-cx-fg2",
          tint,
        )}
      >
        <CornerLeftUp
          className="h-3.5 w-3.5 shrink-0 text-cx-purple"
          aria-hidden
        />
        {t("scenarioRun.loopBackArm", { n: from })}
      </div>
    </li>
  );
};

export default LoopBlock;
