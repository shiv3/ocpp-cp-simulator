import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, PlugZap, SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import ChargePointConfigModal, {
  defaultChargePointConfig,
} from "../../components/ChargePointConfigModal";
import { useChargePoints } from "../../data/hooks/useChargePoints";
import { useConfig } from "../../data/hooks/useConfig";
import { useServerInfo } from "../../data/hooks/useServerInfo";
import { useDataContext } from "../../data/providers/DataProvider";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import SidePanel from "../components/SidePanel";
import { useNow } from "../lib/useNow";
import { usePanelParams } from "../lib/usePanelParams";
import BulkActionsMenu from "./dashboard/BulkActionsMenu";
import ConnectorTable from "./dashboard/ConnectorTable";
import CpDetailContent from "./cp/CpDetailContent";
import CpHierarchyRow from "./dashboard/CpHierarchyRow";
import CpListFilterBar from "./dashboard/CpListFilterBar";
import CpTable from "./dashboard/CpTable";
import { filterChargePoints } from "./dashboard/cpListFilters";
import ViewSwitch from "./dashboard/ViewSwitch";
import { useCpConfigActions } from "./dashboard/useCpConfigActions";
import { useCpListParams } from "./dashboard/useCpListParams";
import { useCpListRows } from "./dashboard/useCpListRows";

const DashboardPage: React.FC = () => {
  const { mode } = useDataContext();
  const serverInfo = useServerInfo();
  const { config, isLoading } = useConfig();
  const { chargePoints } = useChargePoints(config, { isLoading });
  const { addCp } = useCpConfigActions();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [bulkReport, setBulkReport] = useState<string | null>(null);
  // Re-render so the relative Heartbeat times stay current between heartbeats.
  useNow();

  const { view, filters, setView, setFilters } = useCpListParams();
  // Local-mode snapshots don't carry `config` (the browser owns config, not
  // the service) — fall back to the shared local config's ocppVersion so the
  // version still shows in local mode.
  const { rows, reporters, complete } = useCpListRows(
    chargePoints,
    mode === "local" ? config?.ocppVersion : undefined,
  );
  const shownRows = useMemo(
    () => filterChargePoints(rows, filters),
    [rows, filters],
  );
  const shownConnectorCount = shownRows.reduce(
    (sum, row) => sum + row.connectors.length,
    0,
  );
  // Collapsed connector grids of the Hierarchy view; a view detail, not URL.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const panel = usePanelParams();
  const { cpId: panelCpId, open: openPanel, close: closePanel } = panel;
  const listRef = useRef<HTMLDivElement>(null);
  // `?cp=` on arrival (a reload, or Back from the full page): bring that
  // charge point into view once, when the list has it. Later clicks are on
  // visible rows.
  const initialCpId = useRef(panelCpId);
  const scrolledToInitial = useRef(false);
  useEffect(() => {
    if (!initialCpId.current || scrolledToInitial.current) return;
    const target = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-cp-id]") ?? [],
    ).find((el) => el.dataset.cpId === initialCpId.current);
    if (!target) return;
    scrolledToInitial.current = true;
    // jsdom has no scrollIntoView.
    target.scrollIntoView?.({ block: "nearest" });
  }, [shownRows]);

  // A click on the page itself (not a row, not a control) closes the panel.
  // Portalled content (the Add dialog) bubbles through React but is not in
  // the DOM subtree, so it is excluded by the `contains` check.
  const handleBackgroundClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (panelCpId === null) return;
    const target = event.target as Element;
    if (!event.currentTarget.contains(target)) return;
    if (
      target.closest(
        "[data-cp-id], [role='listbox'], button, a, input, select, label",
      )
    )
      return;
    closePanel();
  };

  const connectedCount = chargePoints.filter(
    (cp) => cp.status !== OCPPStatus.Unavailable,
  ).length;

  const addButton = (
    <Button type="button" onClick={() => setIsAddOpen(true)}>
      <Plus />
      Add Charge Point
    </Button>
  );

  return (
    <>
      <div className="min-h-full p-6" onClick={handleBackgroundClick}>
        <PageHeader
          title="Charge Points"
          count={`${chargePoints.length} registered · ${connectedCount} connected`}
          actions={
            <>
              <ViewSwitch view={view} onChange={setView} />
              {/* Bulk actions only make sense with several charge points. */}
              {chargePoints.length >= 2 && (
                <BulkActionsMenu
                  cpIds={chargePoints.map((cp) => cp.id)}
                  onReport={setBulkReport}
                />
              )}
              {addButton}
            </>
          }
        />

        {bulkReport && (
          <p
            role="status"
            data-testid="bulk-result"
            className="-mt-2 mb-4 text-xs text-cx-fg2"
          >
            {bulkReport}
          </p>
        )}

        {chargePoints.length === 0 ? (
          <EmptyState
            icon={PlugZap}
            title="No charge points"
            hint="Add a charge point to start simulating OCPP traffic."
            action={addButton}
          />
        ) : (
          <>
            <CpListFilterBar
              filters={filters}
              onChange={setFilters}
              rows={rows}
              shown={{
                cps: shownRows.length,
                connectors: shownConnectorCount,
              }}
            />
            {/* Waits for every charge point to report before it says "no
                match": a list that is still loading is not an empty result. */}
            {complete && shownRows.length === 0 ? (
              <EmptyState
                icon={SearchX}
                title="No charge points match the current filters."
                hint="Change or clear a filter above."
              />
            ) : (
              <div
                ref={listRef}
                className="overflow-hidden rounded-[10px] border border-cx-border bg-cx-card shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none"
              >
                {view === "hierarchy" &&
                  shownRows.map((row) => (
                    <CpHierarchyRow
                      key={row.cp.id}
                      row={row}
                      collapsed={collapsed.has(row.cp.id)}
                      onToggleCollapse={() => toggleCollapsed(row.cp.id)}
                    />
                  ))}
                {view === "cp" && <CpTable rows={shownRows} />}
                {view === "connectors" && <ConnectorTable rows={shownRows} />}
              </div>
            )}
          </>
        )}
        {/* Report each charge point's live row up to this page; render nothing. */}
        {reporters}

        <ChargePointConfigModal
          isOpen={isAddOpen}
          onClose={() => setIsAddOpen(false)}
          onSave={(cpConfig) => void addCp(cpConfig)}
          mode={mode}
          initialConfig={defaultChargePointConfig}
          isNewChargePoint
          soapPublicBase={serverInfo?.soap ?? null}
        />
      </div>

      <SidePanel
        open={panelCpId !== null}
        onClose={closePanel}
        label="Charge point"
      >
        {panelCpId !== null && (
          // Keyed so a swap starts from a clean state (tab, dialogs, snapshot).
          <CpDetailContent
            key={panelCpId}
            cpId={panelCpId}
            variant="panel"
            selectedConnectorId={panel.connectorId}
            onSelectConnector={(id) => openPanel(panelCpId, id)}
          />
        )}
      </SidePanel>
    </>
  );
};

export default DashboardPage;
