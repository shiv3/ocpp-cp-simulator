import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SeqPath } from "./blockTree";
import { DRAG_THRESHOLD_PX } from "./useLaneDrag";

/** Where a drag would land: slot `index` of the sequence at `path`
 *  (`loop`: as the first step of a new Repeat block there). */
export interface TreeDropTarget {
  path: SeqPath;
  index: number;
  loop: boolean;
}

/** The step a drag picked up. */
export interface TreeDragItem {
  id: string;
  path: SeqPath;
  index: number;
}

/** A drag in progress. */
export interface TreeDrag extends TreeDragItem {
  /** How far the pointer moved vertically (px), for the step to follow it. */
  offset: number;
  /** Where a release now would put it; null over nothing droppable. */
  target: TreeDropTarget | null;
}

export interface UseTreeDragOptions {
  /** Where the pointer at (`x`, `y`) would drop the step (read once per move,
   *  from the layout). `offset`: the vertical travel since the press. */
  locate: (
    item: TreeDragItem,
    x: number,
    y: number,
    offset: number,
  ) => TreeDropTarget | null;
  /** A release over a target. */
  onDrop: (item: TreeDragItem, target: TreeDropTarget) => void;
}

interface Pending {
  item: TreeDragItem;
  pointerId: number;
  startY: number;
  started: boolean;
}

/**
 * Drag a step anywhere in the Steps view: within its sequence, into another
 * lane, into or out of a Repeat block. Pointer events, as {@link
 * useLaneDrag}: a press arms it, a move past the threshold starts it, each
 * move asks `locate` for the landing slot, a release calls `onDrop`, and
 * Escape cancels.
 */
export function useTreeDrag({ locate, onDrop }: UseTreeDragOptions): {
  drag: TreeDrag | null;
  handlers: (item: TreeDragItem) => {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  };
} {
  const [drag, setDrag] = useState<TreeDrag | null>(null);
  const pending = useRef<Pending | null>(null);
  const locateRef = useRef(locate);
  const onDropRef = useRef(onDrop);
  locateRef.current = locate;
  onDropRef.current = onDrop;

  const reset = useCallback(() => {
    pending.current = null;
    setDrag(null);
  }, []);

  useEffect(() => {
    if (!drag) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      reset();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [drag, reset]);

  const handlers = useCallback(
    (item: TreeDragItem) => ({
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        pending.current = {
          item,
          pointerId: event.pointerId,
          startY: event.clientY,
          started: false,
        };
      },
      onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
        const current = pending.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const offset = event.clientY - current.startY;
        if (!current.started) {
          if (Math.abs(offset) <= DRAG_THRESHOLD_PX) return;
          current.started = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }
        setDrag({
          ...current.item,
          offset,
          target: locateRef.current(
            current.item,
            event.clientX ?? 0,
            event.clientY,
            offset,
          ),
        });
      },
      onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
        const current = pending.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (current.started) {
          const target = locateRef.current(
            current.item,
            event.clientX ?? 0,
            event.clientY,
            event.clientY - current.startY,
          );
          if (target) onDropRef.current(current.item, target);
        }
        reset();
      },
      onPointerCancel: () => reset(),
    }),
    [reset],
  );

  return { drag, handlers };
}
