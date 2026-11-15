import { useTranslation } from "react-i18next";
import { notify } from "@/lib/toast";
import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { X } from "lucide-react";

import {
  LogViewer,
  type ConnectorFilterValue,
} from "@/components/ui/log-viewer";
import ChargePointConfigForm from "@/components/ChargePointConfigForm";
import { type ChargePointConfig } from "@/components/chargePointConfig";
import { useChargePointView } from "@/data/hooks/useChargePointView";
import { downloadStoredLogs } from "@/lib/downloadStoredLogs";
import { cn } from "@/lib/utils";
import { t as translate } from "@/i18n";
import { useConfig } from "@/data/hooks/useConfig";
import { useDataContext } from "@/data/providers/DataProvider";
import { useServerInfo } from "@/data/hooks/useServerInfo";
import { useActiveScenarioRuns } from "../../lib/useActiveScenarioRuns";
import { useGlobalLogs } from "../../lib/useGlobalLogs";
import { usePanelParams } from "../../lib/usePanelParams";
import type { ChargePointSnapshot } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import type {
  NetworkSimLayerConfig,
  NetworkSimRule,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";

import BottomPanel from "../../components/BottomPanel";
import LabelChips from "../../components/LabelChips";
import PageHeader from "../../components/PageHeader";
import StatusPill from "../../components/StatusPill";
import NetworkSimBadge from "../../components/network-sim/NetworkSimBadge";
import ChargePointControls from "./ChargePointControls";
import CpLabelsCard from "./CpLabelsCard";
import { CpConnectorsArea } from "./CpConnectorsArea";
import { CpDetailSections } from "./CpDetailSections";
import { CpHeaderActions } from "./CpHeaderActions";
import { CpNetworkSimSection } from "./CpNetworkSimSection";
import {
  SECTIONS,
  buildChargePointConfig,
  isSection,
  type Section,
} from "./cpDetailHelpers";
import { useCpConfigActions } from "../dashboard/useCpConfigActions";
import { useChargePointLabels } from "./useChargePointLabels";

export interface CpDetailContentProps {
  cpId: string;
  /**
   * `page` is the full page at `/cp/:id`; `panel` is the same body inside the
   * Charge Points list's side panel (no back link, expand and close buttons).
   */
  variant: "page" | "panel";
  /** The connector in the URL (`?connector=`); the first one when absent. */
  selectedConnectorId: number | null;
  onSelectConnector: (id: number) => void;
  /** Opens a connector's scenario in the run panel (`edit`: its editor).
   *  Without it the scenario card links to the full pages instead. */
  onOpenScenario?: (
    connectorId: number,
    scenarioId: string,
    edit?: boolean,
  ) => void;
}

const CpDetailContent: React.FC<CpDetailContentProps> = ({
  cpId,
  variant,
  selectedConnectorId,
  onSelectConnector,
  onOpenScenario,
}) => {
  const { t } = useTranslation();
  const isPanel = variant === "panel";
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { close: closePanel } = usePanelParams();
  const { mode, chargePointService } = useDataContext();
  const { config: localConfig } = useConfig();
  const serverInfo = useServerInfo();
  const { updateCp, removeCp } = useCpConfigActions();
  const navigate = useNavigate();
  const configCardId = useId();
  const labelsCardId = useId();
  const connectorPanelId = useId();
  const connectorGridRef = useRef<HTMLDivElement>(null);
  const scrolledToConnectorRef = useRef(false);

  const view = useChargePointView(cpId || null);
  const { entries: globalLogEntries } = useGlobalLogs();
  const [snapshot, setSnapshot] = useState<ChargePointSnapshot | undefined>();
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isLabelsOpen, setIsLabelsOpen] = useState(false);
  // #471: relabel in place (cp.labels.set) — Remote only; local charge points
  // have no labels. `undefined` labels are unknown, not empty.
  const { labels, markSaved: markLabelsSaved } = useChargePointLabels(
    cpId,
    snapshot,
  );
  const canSetLabels =
    mode === "remote" && chargePointService.setChargePointLabels !== undefined;
  const [isConnectPending, setIsConnectPending] = useState(false);
  const [isDeletePending, setIsDeletePending] = useState(false);
  const [networkSimGlobalConfig, setNetworkSimGlobalConfig] = useState<
    NetworkSimLayerConfig | null | undefined
  >();
  const [networkSimCpConfig, setNetworkSimCpConfig] = useState<
    NetworkSimLayerConfig | null | undefined
  >();
  const [networkSimLoadError, setNetworkSimLoadError] = useState<string | null>(
    null,
  );
  // Watermark to track which global log entries have been cleared from this
  // tab's view. Only entries with seq > logsClearedBeforeSeq are shown.
  const [logsClearedBeforeSeq, setLogsClearedBeforeSeq] = useState(-1);
  // The Message log tab's Connector filter. It follows the selected connector
  // (the effect below) and the operator may widen it in the Filters sidebar;
  // that choice holds until the selection changes again.
  const [logConnectorFilter, setLogConnectorFilter] = useState<
    ConnectorFilterValue[]
  >([]);

  /** Global rules minus tombstones, as the per-CP editor's inherited baseline. */
  const inheritedNetworkSimRules = useMemo(() => {
    const filtered: Record<string, NetworkSimRule> = {};
    for (const [id, rule] of Object.entries(
      networkSimGlobalConfig?.rules ?? {},
    )) {
      if (rule !== null) filtered[id] = rule;
    }
    return filtered;
  }, [networkSimGlobalConfig]);

  const refreshSnapshot = useCallback(() => {
    if (!cpId) {
      setSnapshot(undefined);
      return;
    }
    void chargePointService
      .getChargePoint(cpId)
      .then((snap) => setSnapshot(snap ?? undefined))
      .catch((err) => {
        console.error(`Failed to fetch snapshot for ${cpId}`, err);
      });
  }, [cpId, chargePointService]);

  const refreshNetworkSim = useCallback(() => {
    if (!cpId) {
      setNetworkSimGlobalConfig(undefined);
      setNetworkSimCpConfig(undefined);
      return;
    }
    setNetworkSimLoadError(null);
    Promise.all([
      chargePointService.getNetworkSimGlobal(),
      chargePointService.getNetworkSimCp(cpId),
    ])
      .then(([global, cp]) => {
        setNetworkSimGlobalConfig(global);
        setNetworkSimCpConfig(cp.config);
      })
      .catch((err) => {
        console.error(`Failed to fetch network sim config for ${cpId}`, err);
        setNetworkSimLoadError(
          err instanceof Error
            ? err.message
            : translate("cp.page.networkSimLoadFailed"),
        );
      });
  }, [cpId, chargePointService]);

  useEffect(() => {
    refreshSnapshot();
    refreshNetworkSim();
  }, [refreshSnapshot, refreshNetworkSim]);

  // When navigating to a different CP, reset the watermark so all entries in
  // the global ring buffer for this CP become visible (old cleared entries are
  // not rehydrated; only new/existing entries in the buffer).
  useEffect(() => {
    setLogsClearedBeforeSeq(-1);
  }, [cpId]);

  const connectorList = useMemo(
    () => Array.from(view.connectors.values()).sort((a, b) => a.id - b.id),
    [view.connectors],
  );

  // Every live run of the CP, queried once; each connector's row shows its own.
  const {
    runs: activeRuns,
    refresh: refreshRuns,
    scheduleRefresh: scheduleRunsRefresh,
  } = useActiveScenarioRuns(
    cpId || null,
    connectorList.map((c) => c.id),
  );

  // Derive the logs to show in the message log by filtering global entries
  // for this CP and reversing them to match the chronological order expected
  // by the list (oldest-first). Entries are newest-first in globalLogEntries,
  // so we reverse after filtering. The watermark only hides entries the user
  // cleared from this view; old cleared entries remain cleared across section
  // switches but new global entries appear.
  const tabLogs = useMemo(() => {
    const filtered = globalLogEntries.filter(
      (e) => e.cpId === cpId && e.seq > logsClearedBeforeSeq,
    );
    return filtered.reverse().map((e) => e.entry);
  }, [globalLogEntries, cpId, logsClearedBeforeSeq]);

  const handleClearTabLogs = useCallback(
    (scope: "screen" | "all") => {
      // Set watermark to the highest seq in globalLogEntries (newest-first, so
      // [0] has the max). This ensures only entries logged after this Clear
      // persist in the view; the global buffer itself is read-only from
      // this view's perspective.
      setLogsClearedBeforeSeq(globalLogEntries[0]?.seq ?? -1);
      // "Clear screen + DB" also deletes the CP's persisted log rows.
      if (scope === "all" && chargePointService.clearStoredLogs) {
        notify
          .promise(chargePointService.clearStoredLogs(cpId), {
            loading: translate("dashboard.logs.clearPending"),
            success: translate("dashboard.logs.clearDone"),
            error: (err) =>
              translate("cp.page.clearLogsFailed", {
                message: err instanceof Error ? err.message : String(err),
              }),
          })
          .catch((err) =>
            console.error(`Failed to clear stored logs for ${cpId}`, err),
          );
      }
    },
    [globalLogEntries, chargePointService, cpId],
  );

  const handleDownloadLogs = useCallback(() => {
    notify
      .promise(downloadStoredLogs(chargePointService, [cpId], cpId), {
        loading: translate("dashboard.logs.downloadPending"),
        success: translate("dashboard.logs.downloadDone"),
        error: (err) =>
          translate("cp.page.downloadLogsFailed", {
            message: err instanceof Error ? err.message : String(err),
          }),
      })
      .catch((err) =>
        console.error(`Failed to download logs for ${cpId}`, err),
      );
  }, [chargePointService, cpId]);

  // The selected connector when this CP has it, else the first one: what the
  // tabs mark, the card shows and Diagnostics starts on.
  const activeConnectorId =
    selectedConnectorId != null &&
    connectorList.some((c) => c.id === selectedConnectorId)
      ? selectedConnectorId
      : (connectorList[0]?.id ?? null);

  useEffect(() => {
    setLogConnectorFilter(activeConnectorId == null ? [] : [activeConnectorId]);
  }, [activeConnectorId]);

  // The chip shows while the filter is exactly the selected connector.
  const logFilteredToActiveConnector =
    activeConnectorId != null &&
    logConnectorFilter.length === 1 &&
    logConnectorFilter[0] === activeConnectorId;

  // On the full page, the connector named in the URL is scrolled into view
  // once, when its card first renders: down the page and along the row.
  useEffect(() => {
    if (isPanel || scrolledToConnectorRef.current) return;
    if (selectedConnectorId == null) return;
    const card = connectorGridRef.current?.querySelector(
      `[data-connector-id="${selectedConnectorId}"]`,
    );
    if (!card) return;
    scrolledToConnectorRef.current = true;
    card.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [isPanel, selectedConnectorId, connectorList.length]);

  // The network simulation section is gated as the block always was: not for a
  // charge point the service reports without one (`networkSim: null`).
  const hasNetworkSim = snapshot?.networkSim !== null;
  const rawTab = searchParams.get("tab");
  const section: Section =
    isSection(rawTab) && (rawTab !== "network" || hasNetworkSim)
      ? rawTab
      : "log";

  // Picking a section is not a navigation worth a history entry.
  const setSection = (next: Section) => {
    const params = new URLSearchParams(searchParams);
    if (next === "log") params.delete("tab");
    else params.set("tab", next);
    setSearchParams(params, { replace: true });
  };
  const visibleSections = SECTIONS.filter(
    (item) => item.value !== "network" || hasNetworkSim,
  );
  // Same proxy for "socket up" that the Charge Points list uses: after an
  // auto-reconnect the transport can be up before BootNotification is
  // re-Accepted, so fall back to a non-Unavailable status.
  const isConnected = view.connected || view.status !== OCPPStatus.Unavailable;

  const resolvedOcppVersion =
    snapshot?.config?.ocppVersion ??
    (mode === "local" ? (localConfig?.ocppVersion ?? undefined) : undefined);
  const resolvedSecurityProfile = snapshot?.config?.securityProfile;
  const resolvedWsUrl =
    snapshot?.config?.wsUrl ??
    (mode === "local" ? (localConfig?.wsURL ?? undefined) : undefined);

  const handleToggleConnect = async () => {
    setIsConnectPending(true);
    try {
      if (isConnected) {
        await chargePointService.disconnect(cpId);
      } else {
        await chargePointService.connect(cpId);
      }
    } catch (err) {
      console.error(
        `Failed to ${isConnected ? "disconnect" : "connect"} ${cpId}`,
        err,
      );
    } finally {
      setIsConnectPending(false);
    }
  };

  const handleSaveConfig = async (cpConfig: ChargePointConfig) => {
    try {
      await updateCp(cpConfig);
      setIsConfigOpen(false);
      refreshSnapshot();
    } catch (err) {
      console.error(`Failed to save config for ${cpId}`, err);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(translate("cp.page.confirmDelete", { id: cpId }))) {
      return;
    }
    setIsDeletePending(true);
    try {
      if (await removeCp(cpId)) {
        // From the panel, stay on the list (the panel closes with its ?cp=).
        if (isPanel) closePanel();
        else navigate("/");
      }
    } finally {
      setIsDeletePending(false);
    }
  };

  // Domain objects (not the snapshot/view-model) — only obtainable in local
  // mode (`getLocalChargePoint`).
  // Remote mode has no equivalent (the daemon owns the domain objects), so
  // the Diagnostics section falls back to an explanatory empty state there.
  const localCp: ChargePoint | null =
    mode === "local" && chargePointService.getLocalChargePoint
      ? ((chargePointService.getLocalChargePoint(cpId) as ChargePoint | null) ??
        null)
      : null;
  const diagnosticsConnector =
    localCp && activeConnectorId != null
      ? localCp.getConnector(activeConnectorId)
      : undefined;

  // Memoized: the open form resets its fields whenever this object changes, so
  // a fresh one per render (every log line re-renders the page) would wipe what
  // the operator is typing.
  const editInitialConfig = useMemo(
    () => buildChargePointConfig(cpId, snapshot, mode, localConfig),
    [cpId, snapshot, mode, localConfig],
  );

  // What the full page and the way back to the list carry over: the connector
  // and the section.
  const carriedParams = new URLSearchParams();
  if (selectedConnectorId != null) {
    carriedParams.set("connector", String(selectedConnectorId));
  }
  if (section !== "log") carriedParams.set("tab", section);
  const carriedQuery = carriedParams.toString();
  const fullPageHref = `/cp/${encodeURIComponent(cpId)}${
    carriedQuery ? `?${carriedQuery}` : ""
  }`;
  // Back from the full page lands on the list with this charge point still
  // open in the panel (the dashboard scrolls its card into view).
  const from = (location.state as { from?: unknown } | null)?.from;
  const backToListHref = `${typeof from === "string" ? from : "/"}?${new URLSearchParams(
    { cp: cpId, ...Object.fromEntries(carriedParams) },
  )}`;

  const connectorIds = connectorList.map((c) => c.id);
  const runsOn = (connectorId: number) =>
    activeRuns.filter((run) => run.connectorId === connectorId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Everything above the bottom panel scrolls on its own; the panel
          stays docked at the bottom of the page / side panel. */}
      <div
        data-testid="cp-scroll-area"
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          isPanel ? "px-6 py-5" : "p-6",
        )}
      >
        {!isPanel && (
          <Link
            to={backToListHref}
            className="mb-2 inline-block text-sm text-cx-accent hover:underline"
          >
            {t("cp.page.backToList")}
          </Link>
        )}

        <PageHeader
          title={<span className="font-mono">{cpId}</span>}
          titleAs={isPanel ? "h2" : "h1"}
          actions={
            <CpHeaderActions
              cpId={cpId}
              isPanel={isPanel}
              canSetLabels={canSetLabels}
              labels={labels}
              isLabelsOpen={isLabelsOpen}
              labelsCardId={labelsCardId}
              setIsLabelsOpen={setIsLabelsOpen}
              isConfigOpen={isConfigOpen}
              configCardId={configCardId}
              setIsConfigOpen={setIsConfigOpen}
              isConnected={isConnected}
              isConnectPending={isConnectPending}
              handleToggleConnect={handleToggleConnect}
              isDeletePending={isDeletePending}
              handleDelete={handleDelete}
              fullPageHref={fullPageHref}
              closePanel={closePanel}
            />
          }
        >
          <StatusPill status={isConnected ? view.status : "Disconnected"} />
          <NetworkSimBadge summary={snapshot?.networkSim} />
          {resolvedOcppVersion && (
            <span className="font-mono text-[11.5px] text-cx-faint">
              {resolvedOcppVersion}
              {resolvedSecurityProfile != null
                ? ` · SP${resolvedSecurityProfile}`
                : ""}
            </span>
          )}
          <LabelChips labels={labels} />
        </PageHeader>

        {resolvedWsUrl && (
          <div className="-mt-2 mb-4 font-mono text-xs text-cx-muted">
            {resolvedWsUrl}
          </div>
        )}

        {isLabelsOpen && canSetLabels && labels !== undefined && (
          <CpLabelsCard
            key={cpId}
            id={labelsCardId}
            labels={labels}
            onSave={async (next) => {
              await chargePointService.setChargePointLabels!(cpId, next);
              markLabelsSaved(next);
            }}
            onDone={() => setIsLabelsOpen(false)}
          />
        )}

        {isConfigOpen && (
          <div
            id={configCardId}
            className="mb-4 rounded-[10px] border border-cx-border bg-cx-card p-4 shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none"
          >
            <ChargePointConfigForm
              initialConfig={editInitialConfig}
              isNewChargePoint={false}
              mode={mode}
              soapPublicBase={serverInfo?.soap ?? null}
              onSave={(cpConfig) => void handleSaveConfig(cpConfig)}
              onCancel={() => setIsConfigOpen(false)}
            />
          </div>
        )}

        <ChargePointControls
          cpId={cpId}
          connected={isConnected}
          heartbeat={view.heartbeat}
        />

        <CpConnectorsArea
          cpId={cpId}
          isPanel={isPanel}
          connectorList={connectorList}
          connectorIds={connectorIds}
          activeConnectorId={activeConnectorId}
          onSelectConnector={onSelectConnector}
          onOpenScenario={onOpenScenario}
          connectorPanelId={connectorPanelId}
          connectorGridRef={connectorGridRef}
          runsOn={runsOn}
          refreshRuns={refreshRuns}
          scheduleRunsRefresh={scheduleRunsRefresh}
        />
      </div>

      <BottomPanel
        label={t("cp.page.panelLabel")}
        tabsLabel={t("cp.page.sectionsLabel")}
        tabs={visibleSections.map((item) => ({
          value: item.value,
          label: t(item.labelKey),
        }))}
        active={section}
        onSelect={setSection}
        storageKey={
          isPanel
            ? "ocpp-cp.console.cp-panel.side"
            : "ocpp-cp.console.cp-panel.page"
        }
        toolbar={
          section === "log" ? (
            // The viewer's toolbar counts the lines; this link leads to the
            // Message Log page, filtered to this charge point.
            <>
              {logFilteredToActiveConnector && (
                <span className="inline-flex items-center gap-1 rounded-full border border-cx-border bg-cx-sub px-2 text-[11.5px] leading-5 text-cx-fg2">
                  {t("cp.connector.title", { id: activeConnectorId })}
                  <button
                    type="button"
                    aria-label={t("cp.page.showEveryConnector")}
                    title={t("cp.page.showEveryConnector")}
                    onClick={() => setLogConnectorFilter([])}
                    className="inline-flex items-center rounded-full text-cx-muted hover:text-cx-fg"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              )}
              <Link
                to={`/logs?cp=${encodeURIComponent(cpId)}`}
                className="truncate whitespace-nowrap text-xs text-cx-accent hover:underline"
              >
                {t("cp.page.openInMessageLog")}
              </Link>
            </>
          ) : undefined
        }
      >
        {section === "log" && (
          // The Message Log page's viewer, on this charge point's lines: it
          // fills the panel's body.
          <section
            data-testid="cp-message-log"
            className="flex h-full min-h-0 flex-col"
          >
            <LogViewer
              logs={tabLogs}
              onClear={handleClearTabLogs}
              onDownload={handleDownloadLogs}
              defaultFiltersOpen={!isPanel}
              selectedConnectorIds={logConnectorFilter}
              onConnectorFilterChange={setLogConnectorFilter}
              className="min-h-0 flex-1"
            />
          </section>
        )}

        <CpDetailSections
          section={section}
          cpId={cpId}
          resolvedOcppVersion={resolvedOcppVersion}
          isConnected={isConnected}
          connectorList={connectorList}
          activeConnectorId={activeConnectorId}
          onSelectConnector={onSelectConnector}
          localCp={localCp}
          diagnosticsConnector={diagnosticsConnector}
        />

        {section === "network" && (
          <CpNetworkSimSection
            cpId={cpId}
            chargePointService={chargePointService}
            snapshot={snapshot}
            isConnected={isConnected}
            networkSimLoadError={networkSimLoadError}
            networkSimGlobalConfig={networkSimGlobalConfig}
            networkSimCpConfig={networkSimCpConfig}
            inheritedNetworkSimRules={inheritedNetworkSimRules}
            refreshNetworkSim={refreshNetworkSim}
          />
        )}
      </BottomPanel>
    </div>
  );
};

export default CpDetailContent;
