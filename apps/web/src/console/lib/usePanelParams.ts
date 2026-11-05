import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

export interface PanelParams {
  /** The charge point open in the side panel (`?cp=`), or null when closed. */
  cpId: string | null;
  /** The selected connector (`?connector=`), or null when none / not a number. */
  connectorId: number | null;
  /** Opens (or swaps) the panel; `connectorId` is dropped when omitted. */
  open(cpId: string, connectorId?: number): void;
  close(): void;
  /** True when `cpId` is the open charge point (and the connector, if given). */
  isOpen(cpId: string, connectorId?: number): boolean;
}

/**
 * The side panel's state lives in the URL (`/?cp=<id>&connector=<n>`), so a
 * reload or a shared link reopens it. Opening from a closed state pushes one
 * history entry (Back closes the panel); swapping and closing replace it, so
 * Back never walks through every card the operator clicked. `?tab=` (the
 * section the panel shows below the connector) is written by the panel itself
 * and dropped here with the charge point it belonged to. Other search params
 * (the list's filters) are kept untouched.
 */
export function usePanelParams(): PanelParams {
  const [params, setParams] = useSearchParams();
  const cpId = params.get("cp");
  const rawConnector = params.get("connector");
  const connectorId = useMemo(() => {
    if (rawConnector === null || !/^\d+$/.test(rawConnector)) return null;
    return Number(rawConnector);
  }, [rawConnector]);

  const open = useCallback(
    (nextCpId: string, nextConnectorId?: number) => {
      const next = new URLSearchParams(params);
      next.set("cp", nextCpId);
      if (nextConnectorId === undefined) next.delete("connector");
      else next.set("connector", String(nextConnectorId));
      // `tab` (the lower half's section) belongs to one charge point: another
      // charge point opens on its message log, the same one keeps its section.
      if (nextCpId !== cpId) next.delete("tab");
      setParams(next, { replace: cpId !== null });
    },
    [params, setParams, cpId],
  );

  const close = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete("cp");
    next.delete("connector");
    next.delete("tab");
    setParams(next, { replace: true });
  }, [params, setParams]);

  const isOpen = useCallback(
    (id: string, connector?: number) =>
      cpId === id && (connector === undefined || connector === connectorId),
    [cpId, connectorId],
  );

  return { cpId, connectorId, open, close, isOpen };
}
