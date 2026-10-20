import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import type {
  ChargePointService,
  ChargePointSnapshot,
} from "../../data/interfaces/ChargePointService";
import { useDataContext } from "../../data/providers/DataProvider";
import {
  LIBRARY_SCOPE,
  assignLibraryScenario,
  deleteLibraryScenario,
  listScopeDefinitions,
  migrateToLibrary,
  saveLibraryScenario,
  usedBy as usedByOf,
} from "./scenarioLibrary";
import type { ScenarioLibraryItem } from "./useAllScenarios";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One scope's definitions, read on mount and kept current by
 * `subscribeScenarioDefinitions`. `cpId === null` reads nothing.
 */
export function useScopeDefinitions(
  cpId: string | null,
  connectorId: number | null,
): {
  definitions: ScenarioDefinition[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const { chargePointService } = useDataContext();
  const [definitions, setDefinitions] = useState<ScenarioDefinition[]>([]);
  const [isLoading, setIsLoading] = useState(cpId !== null);
  const [error, setError] = useState<string | null>(null);
  // An older read must not overwrite a newer one (or a pushed update).
  const genRef = useRef(0);

  const refresh = useCallback(async () => {
    if (cpId === null) return;
    const gen = ++genRef.current;
    try {
      const defs = await listScopeDefinitions(
        chargePointService,
        cpId,
        connectorId,
      );
      if (gen !== genRef.current) return;
      setDefinitions(defs);
      setError(null);
    } catch (err) {
      if (gen !== genRef.current) return;
      setError(errorText(err));
    } finally {
      if (gen === genRef.current) setIsLoading(false);
    }
  }, [chargePointService, cpId, connectorId]);

  useEffect(() => {
    if (cpId === null) {
      setDefinitions([]);
      setIsLoading(false);
      return undefined;
    }
    setIsLoading(true);
    void refresh();
    const unsubscribe = chargePointService.subscribeScenarioDefinitions(
      cpId,
      connectorId,
      (defs) => {
        genRef.current += 1;
        setDefinitions(defs ?? []);
        setIsLoading(false);
      },
    );
    return () => {
      genRef.current += 1;
      unsubscribe();
    };
  }, [chargePointService, cpId, connectorId, refresh]);

  return { definitions, isLoading, error, refresh };
}

interface Scope {
  cpId: string;
  connectorId: number | null;
}

const scopeKey = (cpId: string, connectorId: number | null) =>
  `${cpId}\u0000${connectorId ?? "cp"}`;

/**
 * Every per-charge-point definition (charge point scope and each connector's
 * scope) of `chargePoints`. Unlike `useAllScenarios`, it walks the list it is
 * given rather than `listChargePoints()` once on mount: in Local mode the
 * registry fills in after the page mounts, and the walk must follow it. Each
 * scope is also re-read when its definitions change.
 */
function useChargePointDefinitions(chargePoints: ChargePointSnapshot[]): {
  items: ScenarioLibraryItem[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const { chargePointService } = useDataContext();
  // Snapshots are a new array on every status change: depend on the ids and
  // connector numbers only, or each heartbeat would re-read every scope.
  const layoutKey = JSON.stringify(
    chargePoints.map((cp) => [cp.id, cp.connectors.map((c) => c.id)]),
  );
  const scopes = useMemo<Scope[]>(
    () =>
      (JSON.parse(layoutKey) as Array<[string, number[]]>).flatMap(
        ([cpId, connectorIds]) => [
          { cpId, connectorId: null },
          ...connectorIds.map((connectorId) => ({ cpId, connectorId })),
        ],
      ),
    [layoutKey],
  );

  const [byScope, setByScope] = useState<Map<string, ScenarioDefinition[]>>(
    () => new Map(),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const genRef = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    setError(null);
    try {
      const answers = await Promise.all(
        scopes.map((scope) =>
          listScopeDefinitions(
            chargePointService,
            scope.cpId,
            scope.connectorId,
          ),
        ),
      );
      if (gen !== genRef.current) return;
      setByScope(
        new Map(
          scopes.map((scope, i) => [
            scopeKey(scope.cpId, scope.connectorId),
            answers[i],
          ]),
        ),
      );
    } catch (err) {
      if (gen === genRef.current) setError(errorText(err));
    } finally {
      if (gen === genRef.current) setIsLoading(false);
    }
  }, [chargePointService, scopes]);

  useEffect(() => {
    void refresh();
    const unsubscribes = scopes.map((scope) =>
      chargePointService.subscribeScenarioDefinitions(
        scope.cpId,
        scope.connectorId,
        (defs) => {
          setByScope((prev) => {
            const next = new Map(prev);
            next.set(scopeKey(scope.cpId, scope.connectorId), defs ?? []);
            return next;
          });
        },
      ),
    );
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [chargePointService, scopes, refresh]);

  const items = useMemo(
    () =>
      scopes.flatMap((scope) =>
        (byScope.get(scopeKey(scope.cpId, scope.connectorId)) ?? []).map(
          (scenario) => ({
            cpId: scope.cpId,
            connectorId: scope.connectorId,
            scenario,
          }),
        ),
      ),
    [scopes, byScope],
  );

  return { items, isLoading, error, refresh };
}

// The migration runs once per page load (per service: each test has its own).
const migratedServices = new WeakSet<ChargePointService>();

export interface UseScenarioLibraryResult {
  /** The library scenarios. */
  library: ScenarioDefinition[];
  /** Every per-charge-point definition: the copies (tagged with `libraryId`)
   *  and anything loaded by hand. */
  items: ScenarioLibraryItem[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** The (charge point, connector) scopes holding a copy of `libraryId`. */
  usedBy: (libraryId: string) => ScenarioLibraryItem[];
  /** Saves a library scenario (new or edited) and re-pushes it to its users. */
  save: (scenario: ScenarioDefinition) => Promise<void>;
  /** Un-assigns every user, then deletes the library scenario. */
  remove: (libraryId: string) => Promise<void>;
  /** Makes `libraryId` (or nothing) the connector's scenario. */
  assign: (
    cpId: string,
    connectorId: number,
    libraryId: string | null,
  ) => Promise<void>;
}

/**
 * The Scenario Library for the Scenarios page: the library scope (read and
 * subscribed independently of the charge point list) and the per-connector
 * definitions of `chargePoints` (re-read when that list changes), with the
 * actions that keep the two in step. With `migrate`, a library that is empty
 * while charge points hold definitions is filled from them once
 * (`migrateToLibrary`).
 */
export function useScenarioLibrary(
  chargePoints: ChargePointSnapshot[],
  { migrate = false }: { migrate?: boolean } = {},
): UseScenarioLibraryResult {
  const { chargePointService } = useDataContext();
  const libraryScope = useScopeDefinitions(LIBRARY_SCOPE, null);
  const copies = useChargePointDefinitions(chargePoints);
  const { definitions: library } = libraryScope;
  const { items } = copies;
  const refreshLibrary = libraryScope.refresh;
  const refreshCopies = copies.refresh;

  const refresh = useCallback(async () => {
    await Promise.all([refreshLibrary(), refreshCopies()]);
  }, [refreshLibrary, refreshCopies]);

  const loaded = !libraryScope.isLoading && !copies.isLoading;
  useEffect(() => {
    if (!migrate || !loaded || migratedServices.has(chargePointService)) {
      return;
    }
    if (library.length > 0) {
      migratedServices.add(chargePointService);
      return;
    }
    // Nothing to move yet: in Local mode the charge points may still be
    // coming, so leave the door open until some definitions show up.
    if (items.length === 0) return;
    migratedServices.add(chargePointService);
    void migrateToLibrary(chargePointService, library, items)
      .then(async (result) => {
        console.info(
          `[scenario library] migrated ${result.tagged} connector definition(s) into ${result.created.length} library scenario(s)`,
        );
        await refresh();
      })
      .catch((err) => {
        console.error("[scenario library] migration failed", err);
      });
  }, [migrate, loaded, chargePointService, library, items, refresh]);

  const usedBy = useCallback(
    (libraryId: string) => usedByOf(items, libraryId),
    [items],
  );

  const save = useCallback(
    async (scenario: ScenarioDefinition) => {
      await saveLibraryScenario(
        chargePointService,
        scenario,
        usedByOf(items, scenario.id),
      );
      await refresh();
    },
    [chargePointService, items, refresh],
  );

  const remove = useCallback(
    async (libraryId: string) => {
      await deleteLibraryScenario(
        chargePointService,
        libraryId,
        usedByOf(items, libraryId),
      );
      await refresh();
    },
    [chargePointService, items, refresh],
  );

  const assign = useCallback(
    async (cpId: string, connectorId: number, libraryId: string | null) => {
      const scenario = libraryId
        ? (library.find((d) => d.id === libraryId) ?? null)
        : null;
      if (libraryId && !scenario) {
        throw new Error(`Library scenario "${libraryId}" not found`);
      }
      await assignLibraryScenario(
        chargePointService,
        cpId,
        connectorId,
        scenario,
      );
      await refreshCopies();
    },
    [chargePointService, library, refreshCopies],
  );

  return {
    library,
    items,
    isLoading: libraryScope.isLoading || copies.isLoading,
    error: libraryScope.error ?? copies.error,
    refresh,
    usedBy,
    save,
    remove,
    assign,
  };
}
