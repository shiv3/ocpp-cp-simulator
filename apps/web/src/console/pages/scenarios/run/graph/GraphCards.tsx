import React from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import RunStatePill from "../../../../components/RunStatePill";
import {
  NODE_H,
  NODE_W,
  type TreeGraphGeometry,
} from "../../../../lib/treeGraphLayout";
import { stepSummary } from "../../../../lib/scenarioSteps";
import IssueBadge from "../../edit/IssueBadge";
import type { useStepEditing } from "../../edit/stepEditing";
import type { useStepIssues } from "../../edit/issueMarkUi";
import StepTile from "../StepTile";
import {
  CURRENT_CARD,
  laneStyle,
  nodeTitle,
  type BoxPhase,
  type StepTreeViewProps,
} from "../stepVisuals";
import type { Pick, PickTarget } from "./graphShared";

type Editing = ReturnType<typeof useStepEditing<string>>;

/** Every step card of the graph (a button, or a draggable box when editable). */
const GraphCards: React.FC<{
  cards: TreeGraphGeometry["cards"];
  phaseOf: (id: string) => BoxPhase;
  state: StepTreeViewProps["state"];
  currentNodeId: StepTreeViewProps["currentNodeId"];
  selectedStepId: StepTreeViewProps["selectedStepId"];
  live: keyof typeof CURRENT_CARD | null;
  stepIssues: ReturnType<typeof useStepIssues>;
  numbers: ReadonlyMap<string, number | string>;
  editable: boolean;
  editing: Editing;
  drag: Editing["drag"];
  zoom: number;
  pick: Pick | null;
  pickTargets: Map<string, PickTarget> | null;
  hoverId: string | null;
  setHoverId: React.Dispatch<React.SetStateAction<string | null>>;
  commitPick: (id: string) => void;
  onSelectStep: StepTreeViewProps["onSelectStep"];
  onDeleteStep: StepTreeViewProps["onDeleteStep"];
}> = ({
  cards,
  phaseOf,
  state,
  currentNodeId,
  selectedStepId,
  live,
  stepIssues,
  numbers,
  editable,
  editing,
  drag,
  zoom,
  pick,
  pickTargets,
  hoverId,
  setHoverId,
  commitPick,
  onSelectStep,
  onDeleteStep,
}) => {
  const { t } = useTranslation();
  return (
    <>
      {cards.map(({ node: step, x, y, lane, seqPath, index, isFork }) => {
        const phase = phaseOf(step.id);
        const failed = state === "error" && step.id === currentNodeId;
        const selected = selectedStepId === step.id;
        const marked = stepIssues(step.id);
        const className = cn(
          "flex items-center gap-2 rounded-xl border-[1.5px] bg-cx-card px-2.5 text-left",
          phase === "current" && live
            ? CURRENT_CARD[live]
            : failed
              ? "border-cx-rose ring-4 ring-cx-rose/15"
              : phase !== "done" &&
                (marked.style ? marked.style.border : "border-cx-border"),
          marked.highlighted && marked.style?.glow,
          selected && "outline outline-2 outline-cx-accent",
        );
        const place: React.CSSProperties = {
          left: x - NODE_W / 2,
          top: y,
          width: NODE_W,
          height: NODE_H,
        };
        // Done cards take their lane's colour (inline: any lane index).
        const doneBorder: React.CSSProperties =
          phase === "done" && !failed
            ? { borderColor: laneStyle(lane).color }
            : {};
        const number = numbers.get(step.id) ?? "";
        const body = (
          <>
            <span className="w-[14px] shrink-0 text-right font-mono text-[10px] text-cx-faint">
              {number}
            </span>
            <StepTile node={step} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-cx-fg">
                {nodeTitle(step)}
              </span>
              <span className="block truncate text-xs text-cx-muted">
                {stepSummary(step)}
              </span>
            </span>
            {phase === "current" && live && <RunStatePill state={live} />}
            {marked.mark && (
              <IssueBadge
                mark={marked.mark}
                className="absolute -top-2.5 right-8"
              />
            )}
            {marked.description}
          </>
        );

        if (editable) {
          const dragged = drag?.id === step.id;
          const pickTarget = pickTargets?.get(step.id);
          const pickState = !pickTargets
            ? undefined
            : pickTarget?.cap.ok
              ? "valid"
              : "invalid";
          const pickReason = !pickTargets
            ? undefined
            : pickTarget
              ? pickTarget.cap.ok
                ? undefined
                : t(pickTarget.cap.reason)
              : t(
                  pick?.kind === "lane"
                    ? "scenarioRun.pick.notLater"
                    : "scenarioRun.pick.notHere",
                );
          return (
            <div
              key={step.id}
              data-node-id={step.id}
              data-phase={failed ? "failed" : phase}
              data-pick={pickState}
              title={pickReason}
              onPointerEnter={
                pickTargets ? () => setHoverId(step.id) : undefined
              }
              onPointerLeave={
                pickTargets
                  ? () => setHoverId((h) => (h === step.id ? null : h))
                  : undefined
              }
              className={cn(
                "absolute select-none",
                dragged &&
                  "z-20 rounded-xl shadow-[0_8px_24px_rgba(20,20,30,0.18)]",
                pickState === "invalid" && "opacity-35",
                pickState === "valid" &&
                  "z-10 rounded-xl ring-2 ring-cx-accent/50",
                pickState === "valid" &&
                  hoverId === step.id &&
                  "ring-4 ring-cx-accent",
              )}
              style={{
                ...place,
                ...(dragged
                  ? { transform: `translateY(${drag.offset / zoom}px)` }
                  : {}),
              }}
              // A branch point stays where it is; nothing drags while
              // a target is being picked.
              {...(isFork || pickTargets
                ? {}
                : editing.dragHandlers({
                    id: step.id,
                    lane: seqPath,
                    index,
                  }))}
            >
              <button
                type="button"
                aria-pressed={selected}
                data-step-select
                aria-label={t("scenarioRun.selectStep", {
                  n: number,
                  title: nodeTitle(step),
                })}
                title={t("scenarioRun.clickToEdit")}
                onClick={() =>
                  pickTargets ? commitPick(step.id) : onSelectStep?.(step.id)
                }
                onKeyDown={editing.onStepKeyDown(step.id)}
                {...marked.cardProps}
                className={cn(
                  className,
                  "relative h-full w-full",
                  isFork
                    ? "cursor-pointer"
                    : dragged
                      ? "cursor-grabbing"
                      : "cursor-grab",
                )}
                style={doneBorder}
              >
                {body}
              </button>
              {selected && onDeleteStep && !pickTargets && (
                <button
                  type="button"
                  aria-label={t("scenarioRun.removeStep", { n: number })}
                  title={t("scenarioRun.removeThisStep")}
                  // Not the start of a drag.
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onDeleteStep(step.id, { confirm: false })}
                  className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border border-cx-border-strong bg-cx-card text-cx-muted hover:border-cx-rose hover:text-cx-rose"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        }

        const shared = {
          "data-node-id": step.id,
          "data-phase": failed ? "failed" : phase,
          className: cn("absolute", className),
          style: { ...place, ...doneBorder },
          ...marked.cardProps,
        };
        return onSelectStep ? (
          <button
            key={step.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelectStep(step.id)}
            {...shared}
          >
            {body}
          </button>
        ) : (
          <div key={step.id} {...shared}>
            {body}
          </div>
        );
      })}
    </>
  );
};

export default GraphCards;
