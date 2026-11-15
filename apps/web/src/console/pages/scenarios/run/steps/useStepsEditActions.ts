import { useTranslation } from "react-i18next";
import React from "react";

import {
  canInsertLoopAt,
  canMoveStepTo,
  seqAt,
  type SeqPath,
} from "../../../../lib/blockTree";
import { STRUCTURE_TYPE } from "../../../../lib/scenarioSteps";
import { dropIndex } from "../../../../lib/useLaneDrag";
import { useTreeDrag, type TreeDropTarget } from "../../../../lib/useTreeDrag";
import type { StructureKind } from "../../edit/AddStepPicker";
import { useStepEditing } from "../../edit/stepEditing";
import type { StepTreeViewProps } from "../stepVisuals";
import { measureBlocks } from "./stepsShared";

/** The editing state of the stacked-boxes view: a pending Repeat block, the
 *  step picker / keys (`useStepEditing`) and the drag across sequences. */
export function useStepsEditActions(props: StepTreeViewProps) {
  const { tree, onInsertStep, onMoveStep, onMoveStepTo } = props;
  const { t } = useTranslation();
  /** An empty Repeat block the user asked for (UI only: the file has no
   *  such thing until a step is in it) and its open picker. */
  const [pendingLoop, setPendingLoop] = React.useState<{
    path: SeqPath;
    index: number;
  } | null>(null);
  const [pendingPicker, setPendingPicker] = React.useState(false);
  /** Why the last drop (or the one being aimed) is refused. */
  const [dropNotice, setDropNotice] = React.useState<string | null>(null);

  const pendingValid =
    pendingLoop !== null &&
    (() => {
      const seq = seqAt(tree, pendingLoop.path);
      return (
        seq !== null &&
        pendingLoop.index <= seq.blocks.length &&
        canInsertLoopAt(tree, pendingLoop.path, pendingLoop.index).ok
      );
    })();
  const pending = pendingValid ? pendingLoop : null;

  const structureRefusals = (slot: { lane: SeqPath; index: number }) => {
    const refusals: Partial<Record<StructureKind, string>> = {};
    const loopCap = canInsertLoopAt(tree, slot.lane, slot.index);
    if (!loopCap.ok) refusals.loop = t(loopCap.reason);
    return refusals;
  };
  const editing = useStepEditing<SeqPath>(
    {
      ...props,
      structure: {
        pick: (slot, kind) => {
          if (kind === "loop") {
            setDropNotice(null);
            setPendingPicker(false);
            setPendingLoop({ path: slot.lane, index: slot.index });
          } else {
            const type = STRUCTURE_TYPE[kind];
            if (type) onInsertStep?.(slot.lane, slot.index, type);
          }
        },
        refusals: structureRefusals,
      },
    },
    measureBlocks,
  );

  /** What a drop at (`x`, `y`) would hit: a pending Repeat block, an empty
   *  lane, or a slot of the sequence under the pointer (else the step's
   *  own). Reads the layout the browser made. */
  const locate = (
    item: { id: string; path: SeqPath; index: number },
    x: number,
    y: number,
    offset: number,
  ): TreeDropTarget | null => {
    const root = editing.rootRef.current;
    const inside = (el: Element, pad: number) => {
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 &&
        x >= r.left - pad &&
        x <= r.right + pad &&
        y >= r.top - pad &&
        y <= r.bottom + pad
      );
    };
    const zone = Array.from(
      root?.querySelectorAll<HTMLElement>("[data-drop-pending]") ?? [],
    ).find((el) => inside(el, 0));
    if (zone?.dataset.dropPending && pending) {
      return { path: pending.path, index: pending.index, loop: true };
    }
    const hits = [
      ...Array.from(
        root?.querySelectorAll<HTMLElement>("[data-lane-list]") ?? [],
      ).map((el) => ({ el, path: el.dataset.laneList ?? "" })),
      ...Array.from(
        root?.querySelectorAll<HTMLElement>("[data-drop-empty]") ?? [],
      ).map((el) => ({ el, path: el.dataset.dropEmpty ?? "" })),
    ].filter(({ el }) => inside(el, 14));
    // The innermost one: the last in document order.
    const hit = hits[hits.length - 1];
    const path = hit?.path ?? item.path;
    const centres = measureBlocks(path, root);
    if (path === item.path) {
      return {
        path,
        index: dropIndex(centres, item.index, offset),
        loop: false,
      };
    }
    return {
      path,
      index: centres.filter((c) => c < y).length,
      loop: false,
    };
  };

  const dragState = useTreeDrag({
    locate,
    onDrop: (item, target) => {
      if (!target.loop && target.path === item.path) {
        if (target.index !== item.index)
          onMoveStep?.(item.id, target.index - item.index);
        setDropNotice(null);
        return;
      }
      const cap = canMoveStepTo(
        tree,
        item.id,
        target.path,
        target.index,
        target.loop,
      );
      if (!cap.ok) {
        setDropNotice(t("scenarioRun.dropRefused", { reason: t(cap.reason) }));
        return;
      }
      setDropNotice(null);
      onMoveStepTo?.(item.id, target.path, target.index, target.loop);
    },
  });
  const drag = dragState.drag;
  /** The cross-sequence landing (or a Repeat block): not a same-lane move. */
  const crossTarget =
    drag?.target && (drag.target.loop || drag.target.path !== drag.path)
      ? drag.target
      : null;
  const crossCap =
    crossTarget && drag
      ? canMoveStepTo(
          tree,
          drag.id,
          crossTarget.path,
          crossTarget.index,
          crossTarget.loop,
        )
      : null;
  return {
    pending,
    pendingPicker,
    setPendingPicker,
    setPendingLoop,
    dropNotice,
    editing,
    dragState,
    drag,
    crossTarget,
    crossCap,
  };
}
