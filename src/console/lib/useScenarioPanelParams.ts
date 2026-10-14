import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

/** What the Scenarios page's side panel shows: a run of a scenario on a
 *  connector, or a library definition (connector-scope or, with `null`,
 *  charge-point-scope). */
export type ScenarioPanelTarget =
  | { kind: "run"; cpId: string; connectorId: number; scenarioId: string }
  | {
      kind: "def";
      cpId: string;
      connectorId: number | null;
      scenarioId: string;
    };

/** `run:<cp>/<connector>/<id>` or `def:<cp>/<connector|cp>/<id>`, each part
 *  URI-encoded so a `/` inside an id survives. */
export function formatScenarioPanel(target: ScenarioPanelTarget): string {
  const connector =
    target.connectorId === null ? "cp" : String(target.connectorId);
  return `${target.kind}:${[target.cpId, connector, target.scenarioId]
    .map(encodeURIComponent)
    .join("/")}`;
}

export function parseScenarioPanel(
  value: string | null,
): ScenarioPanelTarget | null {
  const match = value?.match(/^(run|def):([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  let parts: string[];
  try {
    parts = match.slice(2).map(decodeURIComponent);
  } catch {
    return null; // a malformed %-escape
  }
  const [cpId, connector, scenarioId] = parts;
  if (/^\d+$/.test(connector)) {
    return {
      kind: match[1] as "run" | "def",
      cpId,
      connectorId: Number(connector),
      scenarioId,
    };
  }
  // Only a definition can be charge-point-scope; a run is on a connector.
  if (match[1] === "def" && connector === "cp") {
    return { kind: "def", cpId, connectorId: null, scenarioId };
  }
  return null;
}

export interface ScenarioPanelParams {
  target: ScenarioPanelTarget | null;
  /** The panel shows the editor (`&edit=1`) instead of the read view. */
  editing: boolean;
  open(target: ScenarioPanelTarget): void;
  close(): void;
  isOpen(target: ScenarioPanelTarget): boolean;
  /** Switches the open panel between its read view and the editor. */
  setEditing(editing: boolean): void;
}

/** The panel's edit mode in the URL (`edit=1`, with the editor's `view`),
 *  so a reload keeps it. Shared by every page with a scenario panel. */
export function withPanelEditing(
  params: URLSearchParams,
  editing: boolean,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (editing) {
    next.set("edit", "1");
  } else {
    next.delete("edit");
    next.delete("view");
  }
  return next;
}

/** True when `edit=1` asks for the panel's editor. */
export function isPanelEditing(params: URLSearchParams): boolean {
  return params.get("edit") === "1";
}

/**
 * The Scenarios page's side panel lives in `?open=` (see
 * `formatScenarioPanel`), with `usePanelParams`'s history rules: opening from
 * a closed page pushes one entry (Back closes it), swapping and closing
 * replace it. `&edit=1` puts the panel in its edit mode (opening, swapping
 * and closing leave it). The page's other parameters (tab, filters) are kept.
 * With `?open=`, `edit` is the panel's flag; without it, the Library tab's
 * inline editor (`edit=<id>`).
 */
export function useScenarioPanelParams(): ScenarioPanelParams {
  const [params, setParams] = useSearchParams();
  const raw = params.get("open");
  const target = useMemo(() => parseScenarioPanel(raw), [raw]);
  const editing = target !== null && isPanelEditing(params);

  const open = useCallback(
    (next: ScenarioPanelTarget) => {
      const updated = withPanelEditing(params, false);
      updated.set("open", formatScenarioPanel(next));
      setParams(updated, { replace: target !== null });
    },
    [params, setParams, target],
  );

  const close = useCallback(() => {
    const updated = withPanelEditing(params, false);
    updated.delete("open");
    setParams(updated, { replace: true });
  }, [params, setParams]);

  const isOpen = useCallback(
    (candidate: ScenarioPanelTarget) =>
      target !== null &&
      formatScenarioPanel(target) === formatScenarioPanel(candidate),
    [target],
  );

  const setEditing = useCallback(
    (next: boolean) => {
      if (target === null) return;
      // Replace: Back leaves the panel rather than stepping out of the editor.
      setParams(withPanelEditing(params, next), { replace: true });
    },
    [params, setParams, target],
  );

  return { target, editing, open, close, isOpen, setEditing };
}
