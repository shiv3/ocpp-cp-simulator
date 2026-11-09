import { useState } from "react";
import { useTranslation } from "react-i18next";
import InlineConfirm from "../../../console/components/InlineConfirm";
import type { IndexMapping } from "./scenarioValue";
import { moveItem, removeItem } from "./scenarioValue";
import type { LaneTarget, NodeFormContext } from "./types";

/** How a lane's target reads: a step, the end, or "no step yet". */
export function laneText(
  t: ReturnType<typeof useTranslation>["t"],
  target: LaneTarget | null,
): string {
  if (!target) return t("scenarioEditor.lane.none");
  return target.kind === "end"
    ? t("scenarios.editor.endOfScenario")
    : target.text;
}

/**
 * Reordering and removing the items behind a step's `<prefix>-<n>` lanes
 * (switch cases, choice options). Each edit goes through
 * `context.onReindex`, which moves the lanes with their items; removing an
 * item whose lane leads somewhere asks first (`confirm`, rendered under
 * that row), and its lane's edge goes only on Yes.
 */
export function useIndexedLanes<T>({
  items,
  prefix,
  context,
  store,
  onChange,
}: {
  items: readonly T[];
  prefix: "case" | "option";
  context: NodeFormContext | undefined;
  /** The step's data with `next` as its list. */
  store: (next: T[]) => Record<string, unknown>;
  /** Without `context.onReindex`: the plain data change. */
  onChange: (data: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<number | null>(null);

  const apply = (next: T[], mapping: IndexMapping) => {
    setPending(null);
    if (context?.onReindex) context.onReindex(store(next), mapping);
    else onChange(store(next));
  };

  const move = (from: number, to: number) => {
    const { next, mapping } = moveItem(items, from, to);
    apply(next, mapping);
  };

  const remove = (index: number) => {
    if (context?.laneTarget?.(`${prefix}-${index}`)) {
      setPending(index);
      return;
    }
    const { next, mapping } = removeItem(items, index);
    apply(next, mapping);
  };

  const confirm = (index: number) => {
    if (pending !== index) return null;
    const target = context?.laneTarget?.(`${prefix}-${index}`) ?? null;
    return (
      <InlineConfirm
        danger
        message={t("scenarioEditor.list.removeWithLane", {
          name: `${prefix}-${index}`,
          target: laneText(t, target),
        })}
        confirmLabel={t("scenarioEditor.list.removeWithLaneConfirm")}
        cancelLabel={t("scenarioEditor.list.keep")}
        onConfirm={() => {
          const { next, mapping } = removeItem(items, index);
          apply(next, mapping);
        }}
        onCancel={() => setPending(null)}
      />
    );
  };

  return { move, remove, confirm };
}
