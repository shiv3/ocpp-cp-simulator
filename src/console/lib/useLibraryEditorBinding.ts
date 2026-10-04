import { useMemo } from "react";

import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import { useChargePoints } from "../../data/hooks/useChargePoints";
import { useConfig } from "../../data/hooks/useConfig";
import { libraryEditorUsers, type LibraryUserState } from "./scenarioLibrary";
import { useAllActiveScenarioRuns } from "./useAllActiveScenarioRuns";
import { useScenarioLibrary } from "./useScenarioLibrary";

/**
 * What the editor needs to edit Library scenario `libraryId` away from the
 * Scenarios page (the charge point page's run panel): its users, each marked
 * when running, and a Save that re-pushes the copies — read here, since
 * that page holds neither the Library nor every charge point's runs.
 */
export function useLibraryEditorBinding(libraryId: string): {
  users: LibraryUserState[];
  save: (scenario: ScenarioDefinition) => Promise<void>;
} {
  const { config, isLoading } = useConfig();
  const { chargePoints } = useChargePoints(config, { isLoading });
  const { runs } = useAllActiveScenarioRuns(chargePoints);
  const { items, save } = useScenarioLibrary(chargePoints);
  return useMemo(
    () => ({ users: libraryEditorUsers(items, runs, libraryId), save }),
    [items, runs, libraryId, save],
  );
}
