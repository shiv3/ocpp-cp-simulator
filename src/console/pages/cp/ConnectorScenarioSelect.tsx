import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDataContext } from "@/data/providers/DataProvider";
import { loadPersistedScenarioIntoRuntime } from "../../../components/scenario/scenarioPersistence";
import { FILTER_SELECT_CLASS } from "../../components/filterStyles";
import {
  assignLibraryScenario,
  assignedLibraryId,
  editScenarioUrl,
  listScopeDefinitions,
  LIBRARY_SCOPE,
} from "../../lib/scenarioLibrary";
import { useScopeDefinitions } from "../../lib/useScenarioLibrary";

export interface ConnectorScenarioSelectProps {
  cpId: string;
  connectorId: number;
  /** Every connector of the charge point, for **Apply to all connectors**. */
  connectorIds: number[];
  /** Re-reads the live runs after **Run** (the run row replaces this one). */
  onRunStarted?: () => void;
}

/** Value of the option standing for a definition that is not a Library copy
 *  (loaded by hand, or not migrated yet). */
const UNLISTED = "__unlisted__";
const NOTE_MS = 2000;

/**
 * The connector's scenario, picked from the Library: a select (`None` first),
 * **▶ Run**, the gear to edit the scenario in the Library, and **Apply to all
 * connectors**. Choosing a scenario assigns it at once — the connector's
 * persisted set becomes one copy of it — so what the select shows is what
 * auto-start and **Run** use.
 */
const ConnectorScenarioSelect: React.FC<ConnectorScenarioSelectProps> = ({
  cpId,
  connectorId,
  connectorIds,
  onRunStarted,
}) => {
  const { chargePointService } = useDataContext();
  const library = useScopeDefinitions(LIBRARY_SCOPE, null);
  const scope = useScopeDefinitions(cpId, connectorId);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    },
    [],
  );

  const showNote = (text: string) => {
    setNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), NOTE_MS);
  };

  const assigned = assignedLibraryId(scope.definitions);
  const assignedScenario = assigned
    ? library.definitions.find((d) => d.id === assigned)
    : undefined;
  // The definition Run starts: the Library copy, else whatever the connector
  // holds (a scenario loaded by hand still runs).
  const current = assigned
    ? scope.definitions.find((d) => d.libraryId === assigned)
    : scope.definitions[0];
  const unlisted = !assigned ? scope.definitions[0] : undefined;
  const value = assigned ?? (unlisted ? UNLISTED : "");

  const fail = (message: string, err: unknown) => {
    console.error(message, err);
    setError(`${message}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const handleChange = async (next: string) => {
    if (next === UNLISTED) return;
    setError(null);
    setBusy(true);
    try {
      const scenario = next
        ? (library.definitions.find((d) => d.id === next) ?? null)
        : null;
      await assignLibraryScenario(
        chargePointService,
        cpId,
        connectorId,
        scenario,
      );
      await scope.refresh();
      showNote("Scenario set");
    } catch (err) {
      fail("Failed to set the scenario", err);
    } finally {
      setBusy(false);
    }
  };

  const handleRun = async () => {
    if (!current) return;
    setError(null);
    setBusy(true);
    try {
      try {
        await chargePointService.runScenario(cpId, connectorId, current.id);
      } catch (err) {
        // The copy is persisted; a runtime that has not picked it up yet
        // (e.g. the charge point was instantiated before the assignment) gets
        // it loaded, then runs it.
        if (!/not found/i.test(err instanceof Error ? err.message : "")) {
          throw err;
        }
        await loadPersistedScenarioIntoRuntime(
          chargePointService,
          cpId,
          connectorId,
          current,
        );
        await chargePointService.runScenario(cpId, connectorId, current.id);
      }
      onRunStarted?.();
    } catch (err) {
      fail("Failed to run the scenario", err);
    } finally {
      setBusy(false);
    }
  };

  const handleApplyToAll = async () => {
    if (!assignedScenario) return;
    setError(null);
    try {
      const others = connectorIds.filter((id) => id !== connectorId);
      const sets = await Promise.all(
        others.map((id) => listScopeDefinitions(chargePointService, cpId, id)),
      );
      const replaced = others.filter(
        (_, i) => sets[i].length > 0 && assignedLibraryId(sets[i]) !== assigned,
      );
      if (
        replaced.length > 0 &&
        typeof window !== "undefined" &&
        !window.confirm(
          `Use "${assignedScenario.name}" on every connector of ${cpId}? It replaces the scenario of ${
            replaced.length === 1 ? "connector" : "connectors"
          } ${replaced.join(", ")}.`,
        )
      ) {
        return;
      }
      setBusy(true);
      await Promise.all(
        connectorIds.map((id) =>
          assignLibraryScenario(chargePointService, cpId, id, assignedScenario),
        ),
      );
      await scope.refresh();
      showNote(`Scenario set on ${connectorIds.length} connectors`);
    } catch (err) {
      fail("Failed to apply the scenario", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="connector-scenario-select"
      className="mt-2 rounded-[10px] border border-cx-border bg-cx-card px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-cx-muted">
          Scenario
        </span>
        <select
          aria-label={`Scenario for connector ${connectorId}`}
          value={value}
          disabled={busy || library.isLoading}
          onChange={(e) => void handleChange(e.target.value)}
          className={`${FILTER_SELECT_CLASS} min-w-[180px]`}
        >
          <option value="">None</option>
          {unlisted && (
            <option value={UNLISTED} disabled>
              {unlisted.name} (not in the Library)
            </option>
          )}
          {library.definitions.map((scenario) => (
            <option key={scenario.id} value={scenario.id}>
              {scenario.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!current || busy}
          onClick={() => void handleRun()}
        >
          ▶ Run
        </Button>
        {current && (
          <Link
            to={editScenarioUrl(cpId, connectorId, current)}
            aria-label="Edit scenario"
            title="Edit scenario"
            className="rounded-md p-1.5 text-cx-muted hover:bg-cx-sub hover:text-cx-fg"
          >
            <Settings className="h-3.5 w-3.5" />
          </Link>
        )}
        {note && (
          <span role="status" className="text-xs text-cx-emerald">
            {note}
          </span>
        )}
        {connectorIds.length > 1 && (
          <button
            type="button"
            disabled={!assignedScenario || busy}
            onClick={() => void handleApplyToAll()}
            className="ml-auto text-xs font-medium text-cx-accent hover:underline disabled:text-cx-faint disabled:no-underline"
          >
            Apply to all connectors
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-cx-rose">
          {error}
        </p>
      )}
    </div>
  );
};

export default ConnectorScenarioSelect;
