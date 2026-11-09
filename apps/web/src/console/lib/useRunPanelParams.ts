import { useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";

import { isPanelEditing, withPanelEditing } from "./useScenarioPanelParams";

export interface RunPanelParams {
  /** The scenario the run panel names (`?run=`), or null when closed. */
  scenarioId: string | null;
  /** The panel shows the editor (`&edit=1`). */
  editing: boolean;
  /** Opens the panel on `scenarioId` for `connectorId`; `edit` starts in the
   *  editor. The charge point stays as it is (`?cp=` on the list). */
  open(connectorId: number, scenarioId: string, edit?: boolean): void;
  close(): void;
  setEditing(editing: boolean): void;
  /** Filled by the editor while editing: its Cancel (asks when dirty). */
  cancelEditRef: React.MutableRefObject<(() => void) | null>;
  /** Esc: closes the read view; in the editor it is the editor's Cancel, not
   *  a close that would drop unsaved edits. */
  handleEscape(): void;
}

/**
 * The connector scenario panel's state in the URL — `?connector=N&run=<id>`
 * and `&edit=1` for the editor — shared by the charge point page and the
 * Charge Points list (whose `?cp=` stays). Opening from a closed panel pushes
 * one history entry (Back closes it); swapping, editing and closing replace.
 * `viewParam` names the parameter the panel's Graph / Steps choice uses, which
 * the editing flag clears (the Charge Points list needs `view` for itself).
 */
export function useRunPanelParams(viewParam = "view"): RunPanelParams {
  const [searchParams, setSearchParams] = useSearchParams();
  const scenarioId = searchParams.get("run") || null;
  const editing = scenarioId !== null && isPanelEditing(searchParams);
  const cancelEditRef = useRef<(() => void) | null>(null);

  const open = useCallback(
    (connectorId: number, id: string, edit = false) => {
      const next = withPanelEditing(searchParams, edit, viewParam);
      next.set("connector", String(connectorId));
      next.set("run", id);
      setSearchParams(next, { replace: scenarioId !== null });
    },
    [searchParams, setSearchParams, scenarioId, viewParam],
  );

  const close = useCallback(() => {
    const next = withPanelEditing(searchParams, false, viewParam);
    next.delete("run");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, viewParam]);

  const setEditing = useCallback(
    (value: boolean) => {
      setSearchParams(withPanelEditing(searchParams, value, viewParam), {
        replace: true,
      });
    },
    [searchParams, setSearchParams, viewParam],
  );

  const handleEscape = useCallback(() => {
    if (!editing) close();
    else if (cancelEditRef.current) cancelEditRef.current();
    else setEditing(false);
  }, [editing, close, setEditing]);

  return {
    scenarioId,
    editing,
    open,
    close,
    setEditing,
    cancelEditRef,
    handleEscape,
  };
}
