import type React from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import type { StepLane } from "../../../lib/scenarioSteps";
import { useLaneDrag, type LaneDrag } from "../../../lib/useLaneDrag";
import type { StepRunViewProps } from "../run/stepVisuals";
import AddStepPicker from "./AddStepPicker";

/** Where a picked step goes: `index` of `lane`. */
export interface InsertSlot {
  lane: StepLane;
  index: number;
}

type EditCallbacks = Pick<
  StepRunViewProps,
  "onInsertStep" | "onMoveStep" | "onDeleteStep"
>;

/**
 * The editing wiring the Steps and Graph views share, so both behave the
 * same: one step picker open at a time (at an insert point or a lane's end),
 * drag to reorder within a lane (`useLaneDrag`), and the keyboard on a
 * focused step (Alt+ArrowUp/Down moves it, keeping the focus on it; Delete
 * asks to remove it). `measure` gives the drag the lane's step centres, given
 * the view's root (`rootRef`).
 */
export function useStepEditing(
  callbacks: EditCallbacks,
  measure: (lane: StepLane, root: HTMLElement | null) => number[],
): {
  slot: InsertSlot | null;
  isSlotOpen: (lane: StepLane, index: number) => boolean;
  openSlot: (lane: StepLane, index: number) => void;
  /** The step picker for the open slot (render it where the slot is). */
  picker: React.ReactNode;
  drag: LaneDrag | null;
  dragHandlers: ReturnType<typeof useLaneDrag>["handlers"];
  onStepKeyDown: (nodeId: string) => (event: React.KeyboardEvent) => void;
  /** Put on the views' root: the keyboard's refocus looks inside it. */
  rootRef: React.RefObject<HTMLDivElement | null>;
} {
  const { onInsertStep, onMoveStep, onDeleteStep } = callbacks;
  const [slot, setSlot] = useState<InsertSlot | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const refocusId = useRef<string | null>(null);

  const { drag, handlers: dragHandlers } = useLaneDrag({
    measure: (lane) => measure(lane, rootRef.current),
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
    step
      ?.querySelector<HTMLElement>('button[aria-label^="Select step"]')
      ?.focus();
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
