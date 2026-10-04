import React, { useCallback, useMemo, useRef, useState } from "react";
import { ListTree } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { createEmptyScenario } from "../lib/scenarioSteps";
import { buildScenarioUrl, useAllScenarios } from "../lib/useAllScenarios";
import type { ScenarioLibraryItem } from "../lib/useAllScenarios";
import { retargetScenarioToConnector } from "../../components/scenario/scenarioPersistence";
import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";
import { useChargePoints } from "../../data/hooks/useChargePoints";
import { useConfig } from "../../data/hooks/useConfig";
import {
  exportScenarioToJSON,
  importScenarioFromJSON,
} from "../../utils/scenarioFile";
import type { ScenarioTemplate } from "../../utils/scenarioTemplates";
import { cn } from "@/lib/utils";
import { useDataContext } from "@/data/providers/DataProvider";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import SidePanel from "../components/SidePanel";
import {
  useAllActiveScenarioRuns,
  type ChargePointRun,
} from "../lib/useAllActiveScenarioRuns";
import {
  formatScenarioPanel,
  useScenarioPanelParams,
  type ScenarioPanelTarget,
} from "../lib/useScenarioPanelParams";
import ActiveRunsTab from "./scenarios/ActiveRunsTab";
import NewScenarioDialog from "./scenarios/NewScenarioDialog";
import type { NewScenarioTarget } from "./scenarios/NewScenarioDialog";
import ScenarioDefinitionPanel from "./scenarios/ScenarioDefinitionPanel";
import ScenarioTable from "./scenarios/ScenarioTable";
import TemplateGallery from "./scenarios/TemplateGallery";
import ScenarioRunContent from "./scenarios/run/ScenarioRunContent";

type ScenariosTab = "active" | "library";

const TABS: ReadonlyArray<{ value: ScenariosTab; label: string }> = [
  { value: "active", label: "Active runs" },
  { value: "library", label: "Library" },
];

type PendingAction =
  | { kind: "new" }
  | { kind: "template"; template: ScenarioTemplate }
  | { kind: "import"; scenario: ScenarioDefinition };

/** console.error + a user-visible alert for a failed library action. Matches
 *  the console.error convention already used by CpDetailPage/ScenarioEditPage,
 *  plus an explicit alert since this page has no inline error slot per-row. */
function reportActionError(message: string, err: unknown): void {
  console.error(message, err);
  if (typeof window !== "undefined") {
    window.alert(message);
  }
}

const runTarget = (run: ChargePointRun): ScenarioPanelTarget => ({
  kind: "run",
  cpId: run.cpId,
  connectorId: run.connectorId,
  scenarioId: run.scenarioId,
});

const defTarget = (item: ScenarioLibraryItem): ScenarioPanelTarget => ({
  kind: "def",
  cpId: item.cpId,
  connectorId: item.connectorId,
  scenarioId: item.scenario.id,
});

function duplicateScenario(scenario: ScenarioDefinition): ScenarioDefinition {
  const now = new Date().toISOString();
  return {
    ...scenario,
    id: crypto.randomUUID(),
    name: `${scenario.name} (copy)`,
    createdAt: now,
    updatedAt: now,
  };
}

const ScenarioLibraryPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { mode } = useDataContext();
  const { config, isLoading: configLoading } = useConfig();
  const { chargePoints } = useChargePoints(config, {
    isLoading: configLoading,
  });
  const activeRuns = useAllActiveScenarioRuns(chargePoints);
  const { items, isLoading, error, save, remove, refresh } = useAllScenarios();

  const [enabledOnly, setEnabledOnly] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panel = useScenarioPanelParams();
  const { target: panelTarget, close: closePanel } = panel;
  // A click on the open row closes its panel, as on the Charge Points list.
  const togglePanel = (target: ScenarioPanelTarget) =>
    panel.isOpen(target) ? closePanel() : panel.open(target);

  const cpFilter = searchParams.get("cp") ?? "";
  // Absent (or any other value) is Active runs, the page's default.
  const tab: ScenariosTab =
    searchParams.get("tab") === "library" ? "library" : "active";

  const filteredItems = useMemo(
    () =>
      items.filter((item) => {
        if (cpFilter && item.cpId !== cpFilter) return false;
        if (enabledOnly && item.scenario.enabled === false) return false;
        return true;
      }),
    [items, cpFilter, enabledOnly],
  );

  const updateCpFilter = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set("cp", value);
    } else {
      next.delete("cp");
    }
    setSearchParams(next);
  };

  const selectTab = (next: ScenariosTab) => {
    const params = new URLSearchParams(searchParams);
    if (next === "library") params.set("tab", "library");
    else params.delete("tab");
    // Replace: Back should leave the page, not step between its tabs.
    setSearchParams(params, { replace: true });
  };

  const handleFileInputChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const scenario = await importScenarioFromJSON(file);
      setPendingAction({ kind: "import", scenario });
    } catch (err) {
      console.error("Failed to import scenario JSON", err);
    }
  };

  const handleDialogConfirm = useCallback(
    async (target: NewScenarioTarget) => {
      const action = pendingAction;
      if (!action) return;
      setPendingAction(null);

      const { cpId, connectorId } = target;
      let scenario: ScenarioDefinition;
      if (action.kind === "new") {
        scenario = createEmptyScenario(
          target.name && target.name.length > 0 ? target.name : "New scenario",
          connectorId === null ? "chargePoint" : "connector",
          connectorId ?? undefined,
        );
      } else if (action.kind === "template") {
        scenario = action.template.createScenario(cpId, connectorId);
      } else {
        scenario = retargetScenarioToConnector(
          action.scenario,
          connectorId,
          new Date().toISOString(),
        );
      }

      try {
        await save(cpId, connectorId, scenario);
        navigate(buildScenarioUrl("edit", cpId, connectorId, scenario.id));
      } catch (err) {
        reportActionError(
          "Failed to save the scenario. Please try again.",
          err,
        );
      }
    },
    [pendingAction, save, navigate],
  );

  const handleToggleEnabled = (item: ScenarioLibraryItem, enabled: boolean) => {
    save(item.cpId, item.connectorId, { ...item.scenario, enabled }).catch(
      (err) =>
        reportActionError(
          "Failed to update the scenario. Please try again.",
          err,
        ),
    );
  };

  const handleDuplicate = (item: ScenarioLibraryItem) => {
    save(item.cpId, item.connectorId, duplicateScenario(item.scenario)).catch(
      (err) =>
        reportActionError(
          "Failed to duplicate the scenario. Please try again.",
          err,
        ),
    );
  };

  const handleExport = (item: ScenarioLibraryItem) => {
    exportScenarioToJSON(item.scenario);
  };

  const handleDelete = (item: ScenarioLibraryItem) => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Delete "${item.scenario.name}"?`)
    ) {
      return;
    }
    remove(item.cpId, item.connectorId, item.scenario.id).catch((err) =>
      reportActionError(
        "Failed to delete the scenario. Please try again.",
        err,
      ),
    );
  };

  // A click on the page itself (not a row, not a control) closes the panel.
  // Portalled content (dialogs, menus) bubbles through React but is not in
  // the DOM subtree, so the `contains` check leaves it out.
  const handleBackgroundClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (panelTarget === null) return;
    const target = event.target as Element;
    if (!event.currentTarget.contains(target)) return;
    if (
      target.closest(
        "[data-run-key], [data-scenario-id], [role='listbox'], button, a, input, select, label",
      )
    )
      return;
    closePanel();
  };

  const panelItem =
    panelTarget?.kind === "def"
      ? items.find(
          (item) =>
            item.cpId === panelTarget.cpId &&
            item.connectorId === panelTarget.connectorId &&
            item.scenario.id === panelTarget.scenarioId,
        )
      : undefined;

  const newScenarioButton = (
    <Button
      type="button"
      size="sm"
      onClick={() => setPendingAction({ kind: "new" })}
    >
      + New scenario
    </Button>
  );

  const dialogProps = (() => {
    if (!pendingAction) return null;
    if (pendingAction.kind === "new") {
      return {
        title: "New scenario",
        description: "Pick a target charge point and connector.",
        requireName: true,
        confirmLabel: "Create",
      };
    }
    if (pendingAction.kind === "template") {
      return {
        title: `Use template: ${pendingAction.template.name}`,
        description: "Pick a target charge point and connector.",
        requireName: false,
        confirmLabel: "Create",
      };
    }
    return {
      title: `Import: ${pendingAction.scenario.name}`,
      description: "Pick a target charge point and connector.",
      requireName: false,
      confirmLabel: "Import",
    };
  })();

  return (
    <>
      <div
        data-scenarios-page=""
        className="min-h-full p-6"
        onClick={handleBackgroundClick}
      >
        <PageHeader
          title="Scenarios"
          count={`${items.length} total`}
          actions={
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => void handleFileInputChange(e)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                Import JSON
              </Button>
              {newScenarioButton}
            </>
          }
        />

        <div
          role="tablist"
          aria-label="Scenarios"
          className="mb-4 flex gap-5 border-b border-cx-border"
        >
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              onClick={() => selectTab(item.value)}
              className={cn(
                "-mb-px border-b-2 px-0.5 pb-2 text-[13.5px] font-medium",
                tab === item.value
                  ? "border-cx-accent text-cx-fg"
                  : "border-transparent text-cx-muted hover:text-cx-fg",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === "active" ? (
          <ActiveRunsTab
            runs={activeRuns.runs}
            // The charge point list loads after the config; until it has, "no
            // runs" would be a guess.
            isLoading={configLoading || activeRuns.isLoading}
            refresh={activeRuns.refresh}
            chargePoints={chargePoints}
            ocppVersionFallback={
              mode === "local" ? config?.ocppVersion : undefined
            }
            isSelected={(run) => panel.isOpen(runTarget(run))}
            onSelect={(run) => togglePanel(runTarget(run))}
          />
        ) : (
          <>
            <TemplateGallery
              onUseTemplate={(template) =>
                setPendingAction({ kind: "template", template })
              }
            />

            <div className="mb-4 flex flex-wrap items-center gap-3">
              <select
                value={cpFilter}
                onChange={(e) => updateCpFilter(e.target.value)}
                className="rounded-md border border-cx-border-strong bg-transparent px-2 py-1.5 text-sm"
              >
                <option value="">All charge points</option>
                {chargePoints.map((cp) => (
                  <option key={cp.id} value={cp.id}>
                    {cp.id}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 text-sm text-cx-fg2">
                <input
                  type="checkbox"
                  checked={enabledOnly}
                  onChange={(e) => setEnabledOnly(e.target.checked)}
                  className="h-4 w-4 rounded border-cx-border-strong"
                />
                Enabled only
              </label>
            </div>

            {error ? (
              <EmptyState
                icon={ListTree}
                title="Couldn't load scenarios"
                hint={`Couldn't load scenarios: ${error}`}
                action={
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void refresh()}
                  >
                    Retry
                  </Button>
                }
              />
            ) : !isLoading && filteredItems.length === 0 ? (
              <EmptyState
                icon={ListTree}
                title="No scenarios"
                hint={
                  items.length === 0
                    ? "Create a scenario or use a template to get started."
                    : "No scenarios match the current filters."
                }
                action={items.length === 0 ? newScenarioButton : undefined}
              />
            ) : (
              <ScenarioTable
                items={filteredItems}
                onToggleEnabled={handleToggleEnabled}
                onDuplicate={handleDuplicate}
                onExport={handleExport}
                onDelete={handleDelete}
                isSelected={(item) => panel.isOpen(defTarget(item))}
                onSelect={(item) => togglePanel(defTarget(item))}
              />
            )}
          </>
        )}

        {dialogProps && (
          <NewScenarioDialog
            isOpen
            title={dialogProps.title}
            description={dialogProps.description}
            chargePoints={chargePoints}
            requireName={dialogProps.requireName}
            confirmLabel={dialogProps.confirmLabel}
            onClose={() => setPendingAction(null)}
            onConfirm={(target) => void handleDialogConfirm(target)}
          />
        )}
      </div>

      <SidePanel
        open={panelTarget !== null}
        onClose={closePanel}
        label="Scenario"
      >
        {panelTarget?.kind === "run" && (
          // Keyed so a swap starts from a clean run state.
          <ScenarioRunContent
            key={formatScenarioPanel(panelTarget)}
            cpId={panelTarget.cpId}
            connectorId={panelTarget.connectorId}
            scenarioId={panelTarget.scenarioId}
            variant="panel"
            onClose={closePanel}
          />
        )}
        {panelTarget?.kind === "def" && (
          <ScenarioDefinitionPanel
            key={formatScenarioPanel(panelTarget)}
            cpId={panelTarget.cpId}
            connectorId={panelTarget.connectorId}
            scenarioId={panelTarget.scenarioId}
            scenario={panelItem?.scenario ?? null}
            isLoading={isLoading}
            runs={activeRuns.runs}
            onClose={closePanel}
          />
        )}
      </SidePanel>
    </>
  );
};

export default ScenarioLibraryPage;
