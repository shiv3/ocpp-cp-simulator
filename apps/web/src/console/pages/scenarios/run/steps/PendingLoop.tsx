import { useTranslation } from "react-i18next";
import React from "react";
import { Repeat, X } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  newLoopIsBounded,
  type Capability,
  type Seq,
  type SeqPath,
} from "../../../../lib/blockTree";
import type { TreeDropTarget } from "../../../../lib/useTreeDrag";
import AddStepPicker from "../../edit/AddStepPicker";
import type { StepTreeViewProps } from "../stepVisuals";
import { midLaneLoopRefusals } from "./stepsShared";

/** The empty Repeat block the user asked for: a C-shaped frame to drop
 *  steps into or add the first step to. Never in the file. */
const PendingLoop: React.FC<{
  seq: Seq;
  pending: { path: SeqPath; index: number };
  tree: StepTreeViewProps["tree"];
  crossTarget: TreeDropTarget | null;
  crossCap: Capability | null;
  pendingPicker: boolean;
  setPendingPicker: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingLoop: React.Dispatch<
    React.SetStateAction<{ path: SeqPath; index: number } | null>
  >;
  onInsertStepIntoLoop: StepTreeViewProps["onInsertStepIntoLoop"];
}> = ({
  seq,
  pending,
  tree,
  crossTarget,
  crossCap,
  pendingPicker,
  setPendingPicker,
  setPendingLoop,
  onInsertStepIntoLoop,
}) => {
  const { t } = useTranslation();
  const index = pending.index;
  const hot = crossTarget?.loop === true;
  // In the middle of a lane the repeat gets a bound (times: 3), and its
  // step must go on after it: no switch / choice / End.
  const bounded = newLoopIsBounded(tree, seq.path, index);
  const typeRefusals = bounded ? midLaneLoopRefusals(t) : undefined;
  return (
    <li data-pending-slot={index} className="list-none">
      <div
        data-pending-loop=""
        data-drop-pending={seq.path}
        aria-label={t("scenarioRun.pendingLoop.title")}
        className="mt-1.5 min-w-0"
      >
        <div className="flex min-h-7 items-center gap-1.5 rounded-t-[12px] rounded-br-[12px] bg-cx-purple/12 px-2.5 py-1 text-xs">
          <Repeat className="h-3.5 w-3.5 shrink-0 text-cx-purple" aria-hidden />
          <span className="flex-1 whitespace-nowrap font-semibold text-cx-purple">
            {t("scenarioRun.pendingLoop.title")}
          </span>
          <button
            type="button"
            aria-label={t("scenarioRun.pendingLoop.remove")}
            title={t("scenarioRun.pendingLoop.remove")}
            onClick={() => {
              setPendingLoop(null);
              setPendingPicker(false);
            }}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-cx-faint hover:bg-cx-rose/10 hover:text-cx-rose"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div
          className={cn(
            "ml-3 border-l-[10px] border-cx-purple/12 py-2 pl-2",
            hot && "border-cx-accent/40",
          )}
        >
          <div
            className={cn(
              "rounded-[10px] border border-dashed px-3 py-3 text-xs text-cx-muted",
              hot
                ? crossCap && !crossCap.ok
                  ? "border-cx-rose bg-cx-rose/10"
                  : "border-cx-accent bg-cx-accent/10"
                : "border-cx-border-strong",
            )}
          >
            <p>{t("scenarioRun.pendingLoop.hint")}</p>
            <p className="mt-1 text-cx-faint">
              {t("scenarioRun.pendingLoop.unsaved")}
            </p>
          </div>
          {pendingPicker ? (
            <div className="mt-1.5">
              <AddStepPicker
                typeRefusals={typeRefusals}
                onPick={(type) => {
                  onInsertStepIntoLoop?.(seq.path, pending.index, type);
                  setPendingPicker(false);
                  setPendingLoop(null);
                }}
                onClose={() => setPendingPicker(false)}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPendingPicker(true)}
              className="mt-1.5 w-full rounded-[10px] border border-dashed border-cx-border-strong py-2 text-[13px] font-medium text-cx-muted hover:text-cx-fg"
            >
              {t("scenarioRun.addStepButton")}
            </button>
          )}
          {bounded && (
            <p
              data-testid="pending-loop-bounded"
              className="mt-1.5 text-xs text-cx-muted"
            >
              {t("scenarioRun.pendingLoop.bounded")}
            </p>
          )}
        </div>
      </div>
    </li>
  );
};

export default PendingLoop;
