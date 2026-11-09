import type React from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import type { ScenarioNodeType } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  useLaneDrag,
  type LaneDrag,
  type LaneKey,
} from "../../../lib/useLaneDrag";
import type { RunViewCommonProps } from "../run/stepVisuals";
import AddStepPicker, { type StructureKind } from "./AddStepPicker";

/** Where a picked step goes: `index` of `lane`. */
export interface InsertSlot<L extends LaneKey = LaneKey> {
  lane: L;
  index: number;
}

type EditCallbacks<L extends LaneKey> = Pick<
  RunViewCommonProps,
  "onMoveStep" | "onDeleteStep"
> & {
  onInsertStep?: (lane: L, index: number, type: ScenarioNodeType) => void;
  /** Wired to offer Repeat / Switch / Choice in the picker. */
  structure?: {
    pick: (slot: InsertSlot<L>, kind: StructureKind) => void;
    /** The structures that cannot go to `slot`, with the reason. */
    refusals?: (slot: InsertSlot<L>) => Partial<Record<StructureKind, string>>;
  };
};

/**
 * The editing wiring the Steps and Graph views share, so both behave the
 * same: one step picker open at a time (at an insert point or a lane's end),
 * drag to reorder within a lane (`useLaneDrag`), and the keyboard on a
 * focused step (Alt+ArrowUp/Down moves it, keeping the focus on it; Delete
 * asks to remove it). `measure` gives the drag the lane's step centres, given
 * the view's root (`rootRef`).
 */
export function useStepEditing<L extends LaneKey>(
  callbacks: EditCallbacks<L>,
  measure: (lane: L, root: HTMLElement | null) => number[],
): {
  slot: InsertSlot<L> | null;
  isSlotOpen: (lane: L, index: number) => boolean;
  openSlot: (lane: L, index: number) => void;
  /** The step picker for the open slot (render it where the slot is). */
  picker: React.ReactNode;
  drag: LaneDrag | null;
  dragHandlers: ReturnType<typeof useLaneDrag>["handlers"];
  onStepKeyDown: (nodeId: string) => (event: React.KeyboardEvent) => void;
  /** Put on the views' root: the keyboard's refocus looks inside it. */
  rootRef: React.RefObject<HTMLDivElement | null>;
} {
  const { onInsertStep, onMoveStep, onDeleteStep, structure } = callbacks;
  const [slot, setSlot] = useState<InsertSlot<L> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const refocusId = useRef<string | null>(null);

  const { drag, handlers: dragHandlers } = useLaneDrag({
    measure: (lane) => measure(lane as L, rootRef.current),
    onDrop: (id, _lane, from, to) => onMoveStep?.(id, to - from),
  });

  // A moved step re-renders elsewhere in the DOM, which can drop the focus:
  // put it back on the same step so Alt+Arrow can be repeated.
  useLayoutEffect(() => {
    const id = refocusId.current;
    if (!id) return;
    refocusId.current = null;
    const step = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>(
        "[data-step-id], [data-node-id]",
      ) ?? [],
    ).find((el) => (el.dataset.stepId ?? el.dataset.nodeId) === id);
    step?.querySelector<HTMLElement>("button[data-step-select]")?.focus();
  });

  const onStepKeyDown = useCallback(
    (nodeId: string) => (event: React.KeyboardEvent) => {
      if (
        event.altKey &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        event.preventDefault();
        refocusId.current = nodeId;
        onMoveStep?.(nodeId, event.key === "ArrowUp" ? -1 : 1);
      } else if (event.key === "Delete" && !event.altKey) {
        event.preventDefault();
        onDeleteStep?.(nodeId, { confirm: true });
      }
    },
    [onMoveStep, onDeleteStep],
  );

  const picker = slot ? (
    <AddStepPicker
      onPick={(type) => {
        onInsertStep?.(slot.lane, slot.index, type);
        setSlot(null);
      }}
      onPickStructure={
        structure
          ? (kind) => {
              structure.pick(slot, kind);
              setSlot(null);
            }
          : undefined
      }
      structureRefusals={structure?.refusals?.(slot)}
      onClose={() => setSlot(null)}
    />
  ) : null;

  return {
    slot,
    isSlotOpen: (lane, index) => slot?.lane === lane && slot.index === index,
    openSlot: (lane, index) => setSlot({ lane, index }),
    picker,
    drag,
    dragHandlers,
    onStepKeyDown,
    rootRef,
  };
}
