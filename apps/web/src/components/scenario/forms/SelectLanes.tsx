import { useTranslation } from "react-i18next";
import { ArrowRight, ChevronDown, ChevronUp, X } from "lucide-react";
import type { NodeFormContext } from "./types";
import { laneText } from "./useIndexedLanes";

/** "→ Step 4 · Notify", "→ End of scenario" or "→ no step yet" for the lane
 *  on `handle`; nothing without the scenario around the step. */
export function LaneLine({
  context,
  handle,
}: {
  context: NodeFormContext | undefined;
  handle: string;
}) {
  const { t } = useTranslation();
  if (!context?.laneTarget) return null;
  const target = context.laneTarget(handle);
  return (
    <div
      data-testid={`lane-${handle}`}
      className="flex min-w-0 items-center gap-1 text-xs text-secondary"
    >
      <ArrowRight className="h-3 w-3 shrink-0" aria-hidden />
      <span className="sr-only">{t("scenarioEditor.lane.leadsTo")}</span>
      <span className={target ? "truncate" : "italic text-muted"}>
        {laneText(t, target)}
      </span>
    </div>
  );
}

/** Up / down / remove buttons of one list row. */
export function RowActions({
  index,
  count,
  name,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  /** "case-1", "option-0": names the row in the buttons' labels. */
  name: string;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const button =
    "rounded p-1 text-secondary hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-gray-700";
  return (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        className={button}
        aria-label={t("scenarioEditor.list.moveUp", { name })}
        title={t("scenarioEditor.list.moveUp", { name })}
        disabled={index === 0}
        onClick={() => onMove(index - 1)}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={button}
        aria-label={t("scenarioEditor.list.moveDown", { name })}
        title={t("scenarioEditor.list.moveDown", { name })}
        disabled={index === count - 1}
        onClick={() => onMove(index + 1)}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={`${button} hover:text-red-600 dark:hover:text-red-400`}
        aria-label={t("scenarioEditor.list.remove", { name })}
        title={t("scenarioEditor.list.remove", { name })}
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
