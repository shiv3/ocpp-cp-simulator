import { useState } from "react";
import { useTranslation } from "react-i18next";
import InlineConfirm from "../../../console/components/InlineConfirm";
import type { IndexMapping } from "./scenarioValue";
import { appendItem, moveItem, removeItem } from "./scenarioValue";
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
 * Adding, reordering and removing the items behind a step's `<prefix>-<n>`
 * lanes (switch cases, choice options). Each edit goes through
 * `context.onReindex`, which moves the lanes with their items; removing an
 * item whose lane leads somewhere asks first (`confirm`, rendered under
 * that row), and its lane's edges go only on Yes. Adding an item whose
 * handle already holds an edge (left in the file past the list, never
 * picked so far) asks too (`addConfirm`, rendered where the new row goes):
 * the new item would start running that edge, so the user keeps it or
 * detaches it; nothing is added before the answer.
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
  const [pendingAdd, setPendingAdd] = useState<{ item: T } | null>(null);

  const apply = (next: T[], mapping: IndexMapping) => {
    setPending(null);
    setPendingAdd(null);
    if (context?.onReindex) context.onReindex(store(next), mapping);
    else onChange(store(next));
  };

  const move = (from: number, to: number) => {
    const { next, mapping } = moveItem(items, from, to);
    apply(next, mapping);
  };

  const remove = (index: number) => {
    setPendingAdd(null);
    if (context?.laneTarget?.(`${prefix}-${index}`)) {
      setPending(index);
      return;
    }
    const { next, mapping } = removeItem(items, index);
    apply(next, mapping);
  };

  const add = (item: T) => {
    setPending(null);
    if (context?.laneTarget?.(`${prefix}-${items.length}`)) {
      setPendingAdd({ item });
      return;
    }
    setPendingAdd(null);
    onChange(store([...items, item]));
  };

  /** The question asked before an add would revive an edge, or null. */
  const addConfirm = () => {
    if (!pendingAdd) return null;
    const index = items.length;
    const handle = `${prefix}-${index}`;
    const target = context?.laneTarget?.(handle) ?? null;
    if (!target) return null;
    const count = context?.laneEdgeCount?.(handle) ?? 1;
    const added = (detach: boolean) => {
      const { next, mapping } = appendItem(items, pendingAdd.item, detach);
      apply(next, mapping);
    };
    const keep = () => added(false);
    const detach = () => added(true);
    return (
      <InlineConfirm
        className="[&>span]:basis-full"
        message={t(
          count > 1
            ? "scenarioEditor.list.reviveLanes"
            : "scenarioEditor.list.reviveLane",
          { name: handle, target: laneText(t, target), count },
        )}
        confirmLabel={t("scenarioEditor.list.reviveKeep")}
        cancelLabel={t("scenarioEditor.list.cancel")}
        onConfirm={keep}
        onCancel={() => setPendingAdd(null)}
        secondary={
          context?.onReindex
            ? {
                label: t(
                  count > 1
                    ? "scenarioEditor.list.reviveDetachMany"
                    : "scenarioEditor.list.reviveDetach",
                  { count },
                ),
                onClick: detach,
              }
            : undefined
        }
      />
    );
  };

  const confirm = (index: number) => {
    if (pending !== index) return null;
    const handle = `${prefix}-${index}`;
    const target = context?.laneTarget?.(handle) ?? null;
    const count = context?.laneEdgeCount?.(handle) ?? 1;
    return (
      <InlineConfirm
        danger
        // Narrow beside the steps: the question on its own line.
        className="[&>span]:basis-full"
        message={t(
          count > 1
            ? "scenarioEditor.list.removeWithLanes"
            : "scenarioEditor.list.removeWithLane",
          { name: handle, target: laneText(t, target), count },
        )}
        confirmLabel={t(
          count > 1
            ? "scenarioEditor.list.removeWithLanesConfirm"
            : "scenarioEditor.list.removeWithLaneConfirm",
          { count },
        )}
        cancelLabel={t("scenarioEditor.list.keep")}
        onConfirm={() => {
          const { next, mapping } = removeItem(items, index);
          apply(next, mapping);
        }}
        onCancel={() => setPending(null)}
      />
    );
  };

  return { add, move, remove, confirm, addConfirm };
}
