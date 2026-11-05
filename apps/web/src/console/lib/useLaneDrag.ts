import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { StepLane } from "./scenarioSteps";

/** A pointer must travel this far before a press becomes a drag, so a click
 *  still selects. */
export const DRAG_THRESHOLD_PX = 6;

/** One draggable step: its lane and its index there. */
export interface LaneDragItem {
  id: string;
  lane: StepLane;
  index: number;
}

/** A drag in progress. */
export interface LaneDrag {
  id: string;
  lane: StepLane;
  /** The step's index in its lane when the drag started. */
  from: number;
  /** The index it would have after a release now. */
  to: number;
  /** How far the pointer moved vertically (px), for the step to follow it. */
  offset: number;
}

export interface UseLaneDragOptions {
  /** The vertical centre of each step of `lane`, in order, in the pointer's
   *  coordinate space (only differences matter). Read once per drag. */
  measure: (lane: StepLane) => number[];
  /** A release at a new index. */
  onDrop: (id: string, lane: StepLane, from: number, to: number) => void;
}

export interface LaneDragHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
}

/** Where the dragged step lands: the number of the lane's other steps whose
 *  centre is above the dragged step's centre. */
export function dropIndex(
  centres: readonly number[],
  from: number,
  offset: number,
): number {
  const centre = centres[from] + offset;
  return centres.filter((c, i) => i !== from && c < centre).length;
}

/** The steps a drop line sits between: the lane's ids without the dragged
 *  one, split at `to`. null on a side means the lane's edge. */
export function dropNeighbours(
  ids: readonly string[],
  drag: Pick<LaneDrag, "id" | "to">,
): { above: string | null; below: string | null } {
  const rest = ids.filter((id) => id !== drag.id);
  return {
    above: rest[drag.to - 1] ?? null,
    below: rest[drag.to] ?? null,
  };
}

interface Pending {
  item: LaneDragItem;
  pointerId: number;
  startY: number;
  /** Set once the pointer passed the threshold. */
  centres: number[] | null;
}

/**
 * Reorder-by-drag within one lane, on pointer events (no drag-and-drop
 * library): a press arms it, a move past {@link DRAG_THRESHOLD_PX} starts it
 * (the lane is measured then), each move updates the landing index, a
 * release calls `onDrop` when the index changed, and Escape cancels. A drag
 * never leaves its lane: the landing index is always within it. Shared by the
 * editor's Steps and Graph views so they behave the same.
 */
export function useLaneDrag({ measure, onDrop }: UseLaneDragOptions): {
  drag: LaneDrag | null;
  handlers: (item: LaneDragItem) => LaneDragHandlers;
} {
  const [drag, setDrag] = useState<LaneDrag | null>(null);
  const pending = useRef<Pending | null>(null);
  // Latest callbacks without re-creating the handlers on every render.
  const measureRef = useRef(measure);
  const onDropRef = useRef(onDrop);
  measureRef.current = measure;
  onDropRef.current = onDrop;

  const reset = useCallback(() => {
    pending.current = null;
    setDrag(null);
  }, []);

  useEffect(() => {
    if (!drag) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Capture phase + preventDefault: the side panel's own Esc (a document
      // listener that skips handled keys) must not close the panel too.
      event.preventDefault();
      reset();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [drag, reset]);

  const handlers = useCallback(
    (item: LaneDragItem): LaneDragHandlers => ({
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        pending.current = {
          item,
          pointerId: event.pointerId,
          startY: event.clientY,
          centres: null,
        };
      },
      onPointerMove: (event) => {
        const current = pending.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const offset = event.clientY - current.startY;
        if (!current.centres) {
          if (Math.abs(offset) <= DRAG_THRESHOLD_PX) return;
          current.centres = measureRef.current(current.item.lane);
          // Keep receiving moves when the pointer leaves the element. Only
          // once the drag starts: a capture retargets the click that follows
          // a plain press, and the press must still select.
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }
        setDrag({
          id: current.item.id,
          lane: current.item.lane,
          from: current.item.index,
          to: dropIndex(current.centres, current.item.index, offset),
          offset,
        });
      },
      onPointerUp: (event) => {
        const current = pending.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (current.centres) {
          const to = dropIndex(
            current.centres,
            current.item.index,
            event.clientY - current.startY,
          );
          if (to !== current.item.index) {
            onDropRef.current(
              current.item.id,
              current.item.lane,
              current.item.index,
              to,
            );
          }
        }
        reset();
      },
      onPointerCancel: () => reset(),
    }),
    [reset],
  );

  return { drag, handlers };
}
