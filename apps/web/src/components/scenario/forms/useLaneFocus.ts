import { useCallback, useEffect, useRef, useState } from "react";
import type { NodeFormContext } from "./types";

const HIGHLIGHT_MS = 1800;
const FIELD =
  "input:not([disabled]), textarea:not([disabled]), select:not([disabled])";

/** Classes of a row that can be opened (see `useLaneFocus`). */
export const LANE_ROW_FOCUS_CLASS =
  "outline-none data-[lane-focus=true]:ring-2 data-[lane-focus=true]:ring-cx-accent";

/**
 * Lets the lane tags of the graph / steps views open a row of the form
 * (`context.focusLane`): the row scrolls into view, is highlighted for a
 * moment and its first field takes focus (a row without an editable field,
 * as in the read-only preview or the `default` row, takes focus itself).
 * Spread `rowProps(handle)` on the row's element.
 */
export function useLaneFocus(context: NodeFormContext | undefined) {
  const rows = useRef(new Map<string, HTMLElement>());
  const [active, setActive] = useState<string | null>(null);
  const request = context?.focusLane;
  const handle = request?.handle;
  const nonce = request?.nonce;

  useEffect(() => {
    if (handle === undefined) return;
    const row = rows.current.get(handle);
    if (!row) return;
    row.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    // A field of a disabled fieldset (the read-only preview) cannot take
    // focus: the row does.
    const field = [...row.querySelectorAll<HTMLElement>(FIELD)].find(
      (el) => !el.matches(":disabled"),
    );
    (field ?? row).focus({ preventScroll: true });
    setActive(handle);
    const timer = setTimeout(() => setActive(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [handle, nonce]);

  const rowProps = useCallback(
    (name: string) => ({
      ref: (el: HTMLElement | null) => {
        if (el) rows.current.set(name, el);
        else rows.current.delete(name);
      },
      tabIndex: -1,
      "data-lane-handle": name,
      "data-lane-focus": active === name ? ("true" as const) : undefined,
    }),
    [active],
  );
  return { rowProps };
}
