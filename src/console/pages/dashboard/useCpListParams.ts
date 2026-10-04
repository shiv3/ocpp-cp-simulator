import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import {
  parseCpListFilters,
  parseCpListView,
  type CpListFilters,
  type CpListView,
} from "./cpListFilters";

export interface CpListParams {
  view: CpListView;
  filters: CpListFilters;
  setView(view: CpListView): void;
  /** Sets the given filters; an empty value or an unchecked flag leaves the
   *  parameter out of the URL. */
  setFilters(patch: Partial<CpListFilters>): void;
}

/**
 * The list's view and filters live in the URL (`?view=cp&status=Charging`),
 * so a reload or a shared link shows the same list. Changes replace the
 * history entry: Back should leave the page, not undo each keystroke. The
 * panel's own params (`cp`, `connector`) are kept untouched, and the panel
 * keeps these (see `usePanelParams`).
 */
export function useCpListParams(): CpListParams {
  const [params, setParams] = useSearchParams();
  const view = useMemo(() => parseCpListView(params), [params]);
  const filters = useMemo(() => parseCpListFilters(params), [params]);

  const update = useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(params);
      for (const [name, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(name);
        else next.set(name, value);
      }
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const setView = useCallback(
    (next: CpListView) => update({ view: next === "hierarchy" ? null : next }),
    [update],
  );

  const setFilters = useCallback(
    (patch: Partial<CpListFilters>) => {
      const changes: Record<string, string | null> = {};
      if (patch.q !== undefined) changes.q = patch.q;
      if (patch.conn !== undefined) changes.conn = patch.conn;
      if (patch.status !== undefined) changes.status = patch.status;
      if (patch.version !== undefined) changes.version = patch.version;
      if (patch.connected !== undefined)
        changes.connected = patch.connected ? "1" : null;
      if (patch.scenario !== undefined)
        changes.scenario = patch.scenario ? "1" : null;
      update(changes);
    },
    [update],
  );

  return { view, filters, setView, setFilters };
}
