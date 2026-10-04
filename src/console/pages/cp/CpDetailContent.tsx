import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { Maximize2, MoreHorizontal, Settings, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ChargePointConfigForm from "@/components/ChargePointConfigForm";
import {
  defaultChargePointConfig,
  type ChargePointConfig,
} from "@/components/chargePointConfig";
import { getConfigBasicAuthPassword } from "@/data/configPort";
import { useChargePointView } from "@/data/hooks/useChargePointView";
import { downloadStoredLogs } from "@/lib/downloadStoredLogs";
import { cn } from "@/lib/utils";
import { useConfig } from "@/data/hooks/useConfig";
import { useDataContext } from "@/data/providers/DataProvider";
import { useServerInfo } from "@/data/hooks/useServerInfo";
import { useActiveScenarioRuns } from "../../lib/useActiveScenarioRuns";
import { useGlobalLogs } from "../../lib/useGlobalLogs";
import { usePanelParams } from "../../lib/usePanelParams";
import type { ChargePointSnapshot } from "@/data/interfaces/ChargePointService";
import type { WireSimulatorConfig } from "@/protocol";
import type {
  NetworkSimLayerConfig,
  NetworkSimRule,
} from "@/cp/infrastructure/transport/network-sim/config";
import type { ChargePoint } from "@/cp/domain/charge-point/ChargePoint";
import { OCPPStatus } from "@/cp/domain/types/OcppTypes";

import EmptyState from "../../components/EmptyState";
import { FILTER_SELECT_CLASS } from "../../components/filterStyles";
import ExpertCallPanel from "./ExpertCallPanel";
import PageHeader from "../../components/PageHeader";
import StatusPill from "../../components/StatusPill";
import NetworkSimBadge from "../../components/network-sim/NetworkSimBadge";
import ManualDisconnectButtons from "../../components/network-sim/ManualDisconnectButtons";
import ChargePointControls from "./ChargePointControls";
import CompactLogList from "./CompactLogList";
import ConnectorCard from "./ConnectorCard";
import ConnectorRunRow from "./ConnectorRunRow";
import ConnectorTabs from "./ConnectorTabs";
import TransactionsTab from "./TransactionsTab";
import { useCpConfigActions } from "../dashboard/useCpConfigActions";
import { NetworkSimEditor } from "../../components/network-sim/NetworkSimEditor";

const StateTransitionViewer = lazy(
  () => import("@/components/state-transition/StateTransitionViewer"),
);
const SessionAnalysisPanel = lazy(() => import("./SessionAnalysisPanel"));

/** What the lower half shows (`?tab=`); `log` is the default and has no param. */
type Section =
  "log" | "transactions" | "analysis" | "diagnostics" | "expert" | "network";

/** The sections the More menu offers after the message log, in menu order. */
const MORE_SECTIONS: ReadonlyArray<{
  value: Exclude<Section, "log">;
  label: string;
}> = [
  { value: "transactions", label: "Transactions" },
  { value: "analysis", label: "Session analysis" },
  { value: "diagnostics", label: "Diagnostics" },
  { value: "expert", label: "Expert" },
  { value: "network", label: "Network simulation" },
];

function isSection(value: string | null): value is Exclude<Section, "log"> {
  return MORE_SECTIONS.some((section) => section.value === value);
}

/**
 * Builds the `ChargePointConfig` shape `ChargePointConfigForm` expects,
 * from whichever source currently holds this CP's settings — remote mode's
 * `ChargePointSnapshot.config` (daemon-owned, echoed back from the CP's
 * creation params) or local mode's single shared `useConfig()` result
 * (browser-owned, one config for every local CP). Kept private (not exported)
 * so this file's only runtime export stays the default component.
 */
function buildChargePointConfig(
  cpId: string,
  cp: ChargePointSnapshot | undefined,
  mode: "local" | "remote",
  localConfig: WireSimulatorConfig | null,
): ChargePointConfig {
  if (mode === "remote") {
    const c = cp?.config;
    const bn = c?.bootNotification ?? null;
    return {
      ...defaultChargePointConfig,
      cpId: cp?.id ?? cpId,
      connectorNumber:
        c?.connectors ??
        cp?.connectors.length ??
        defaultChargePointConfig.connectorNumber,
      wsURL: c?.wsUrl ?? defaultChargePointConfig.wsURL,
      ocppVersion: c?.ocppVersion ?? defaultChargePointConfig.ocppVersion,
      basicAuthEnabled: !!c?.basicAuth,
      basicAuthUsername: c?.basicAuth?.username ?? "",
      basicAuthPassword: c?.basicAuth?.password ?? "",
      securityProfile: c?.securityProfile,
      soapCallbackUrl: c?.soapCallbackUrl,
      soapCallbackUrlDerived: c?.soapCallbackUrlDerived,
      soapPath: c?.soapPath,
      cpoName: c?.cpoName,
      tlsCaPath: c?.tlsCaPath,
      tlsCertPath: c?.tlsCertPath,
      tlsKeyPath: c?.tlsKeyPath,
      chargePointVendor:
        c?.vendor ?? defaultChargePointConfig.chargePointVendor,
      chargePointModel: c?.model ?? defaultChargePointConfig.chargePointModel,
      firmwareVersion:
        bn?.firmwareVersion ?? defaultChargePointConfig.firmwareVersion,
      chargeBoxSerialNumber: bn?.chargeBoxSerialNumber ?? "",
      chargePointSerialNumber: bn?.chargePointSerialNumber ?? "",
      meterSerialNumber: bn?.meterSerialNumber ?? "",
      meterType: bn?.meterType ?? "",
      iccid: bn?.iccid ?? "",
      imsi: bn?.imsi ?? "",
    };
  }

  if (!localConfig) {
    return { ...defaultChargePointConfig, cpId };
  }

  const connectorNumber =
    localConfig.Experimental?.ChargePointIDs.find(
      (entry) => entry.ChargePointID === cpId,
    )?.ConnectorNumber ?? localConfig.connectorNumber;

  return {
    ...defaultChargePointConfig,
    cpId,
    connectorNumber,
    wsURL: localConfig.wsURL,
    ocppVersion: localConfig.ocppVersion,
    basicAuthEnabled: localConfig.basicAuthSettings.enabled,
    basicAuthUsername: localConfig.basicAuthSettings.username,
    basicAuthPassword: getConfigBasicAuthPassword(localConfig),
    autoMeterValueEnabled: localConfig.autoMeterValueSetting.enabled,
    autoMeterValueInterval: localConfig.autoMeterValueSetting.interval,
    autoMeterValue: localConfig.autoMeterValueSetting.value,
    chargePointVendor:
      localConfig.BootNotification?.chargePointVendor ??
      defaultChargePointConfig.chargePointVendor,
    chargePointModel:
      localConfig.BootNotification?.chargePointModel ??
      defaultChargePointConfig.chargePointModel,
    firmwareVersion:
      localConfig.BootNotification?.firmwareVersion ??
      defaultChargePointConfig.firmwareVersion,
    chargeBoxSerialNumber:
      localConfig.BootNotification?.chargeBoxSerialNumber ?? "",
    chargePointSerialNumber:
      localConfig.BootNotification?.chargePointSerialNumber ?? "",
    meterSerialNumber: localConfig.BootNotification?.meterSerialNumber ?? "",
    meterType: localConfig.BootNotification?.meterType ?? "",
    iccid: localConfig.BootNotification?.iccid ?? "",
    imsi: localConfig.BootNotification?.imsi ?? "",
  };
}

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
}

/** Heading row of a lower-half section, with the way back to the message log. */
const SectionHeader: React.FC<{ title: string; backSearch: string }> = ({
  title,
  backSearch,
}) => (
  <div className="mb-3 flex items-center justify-between gap-2">
    <h3 className="text-sm font-semibold text-cx-fg">{title}</h3>
    <Link
      replace
      to={{ search: backSearch }}
      className="text-xs text-cx-accent hover:underline"
    >
      ← Message log
    </Link>
  </div>
);

const CpDetailContent: React.FC<CpDetailContentProps> = ({
  cpId,
  variant,
  selectedConnectorId,
  onSelectConnector,
}) => {
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
  const connectorPanelId = useId();

  const view = useChargePointView(cpId || null);
  const { entries: globalLogEntries } = useGlobalLogs();
  const [snapshot, setSnapshot] = useState<ChargePointSnapshot | undefined>();
  const [isConfigOpen, setIsConfigOpen] = useState(false);
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
            : "Failed to load network simulation config",
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
        void chargePointService.clearStoredLogs(cpId).catch((err) => {
          console.error(`Failed to clear stored logs for ${cpId}`, err);
          alert(
            `Failed to clear stored logs: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    },
    [globalLogEntries, chargePointService, cpId],
  );

  const handleDownloadLogs = useCallback(() => {
    void downloadStoredLogs(chargePointService, [cpId], cpId).catch((err) => {
      console.error(`Failed to download logs for ${cpId}`, err);
      alert(
        `Failed to download logs: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, [chargePointService, cpId]);

  // The selected connector when this CP has it, else the first one: what the
  // tabs mark, the card shows and Diagnostics starts on.
  const activeConnectorId =
    selectedConnectorId != null &&
    connectorList.some((c) => c.id === selectedConnectorId)
      ? selectedConnectorId
      : (connectorList[0]?.id ?? null);

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
  const backToLogSearch = (() => {
    const params = new URLSearchParams(searchParams);
    params.delete("tab");
    const query = params.toString();
    return query ? `?${query}` : "";
  })();

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
    if (!window.confirm(`Delete charge point ${cpId}?`)) {
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

  const runsOnActiveConnector = activeRuns.filter(
    (run) => run.connectorId === activeConnectorId,
  );

  return (
    <div className={isPanel ? undefined : "p-6"}>
      {!isPanel && (
        <Link
          to={backToListHref}
          className="mb-2 inline-block text-sm text-cx-accent hover:underline"
        >
          ← Back to charge points
        </Link>
      )}

      <PageHeader
        title={<span className="font-mono">{cpId}</span>}
        titleAs={isPanel ? "h2" : "h1"}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={isConfigOpen}
              aria-controls={isConfigOpen ? configCardId : undefined}
              onClick={() => setIsConfigOpen((open) => !open)}
              className={cn(
                isConfigOpen &&
                  "border-cx-accent bg-cx-sel text-cx-accent hover:bg-cx-sel hover:text-cx-accent",
              )}
            >
              <Settings className="h-3.5 w-3.5" />
              Config
            </Button>
            <Button
              type="button"
              variant={isConnected ? "destructive" : "success"}
              size="sm"
              disabled={isConnectPending}
              onClick={() => void handleToggleConnect()}
            >
              {isConnected ? "Disconnect" : "Connect"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="px-2"
                  aria-label="More"
                  title="More"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className={cn(section === "log" && "font-semibold")}
                  onSelect={() => setSection("log")}
                >
                  Message log
                </DropdownMenuItem>
                {MORE_SECTIONS.filter(
                  (item) => item.value !== "network" || hasNetworkSim,
                ).map((item) => (
                  <DropdownMenuItem
                    key={item.value}
                    className={cn(section === item.value && "font-semibold")}
                    onSelect={() => setSection(item.value)}
                  >
                    {item.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem asChild>
                  <Link to={`/scenarios?cp=${encodeURIComponent(cpId)}`}>
                    Scenarios
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={isDeletePending}
                  className="text-cx-rose focus:text-cx-rose"
                  onSelect={() => void handleDelete()}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {isPanel && (
              <>
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="px-2"
                  title="Open as full page"
                >
                  <Link
                    to={fullPageHref}
                    state={{ from: "/" }}
                    aria-label="Open as full page"
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                  </Link>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="px-2"
                  aria-label="Close side panel"
                  title="Close (Esc)"
                  onClick={closePanel}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </>
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
      </PageHeader>

      {resolvedWsUrl && (
        <div className="-mt-2 mb-4 font-mono text-xs text-cx-muted">
          {resolvedWsUrl}
        </div>
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

      {connectorList.length === 0 ? (
        <EmptyState
          title="No connectors"
          hint="This charge point has no connectors yet."
        />
      ) : (
        <>
          <ConnectorTabs
            connectors={connectorList.map((c) => ({
              id: c.id,
              status: c.status,
            }))}
            selectedId={activeConnectorId}
            onSelect={onSelectConnector}
            panelId={connectorPanelId}
          />
          {activeConnectorId != null && (
            <div
              role="tabpanel"
              id={connectorPanelId}
              aria-label={`Connector ${activeConnectorId}`}
              className="mt-3"
            >
              <ConnectorCard
                key={activeConnectorId}
                cpId={cpId}
                connectorId={activeConnectorId}
              />
              <ConnectorRunRow
                cpId={cpId}
                runs={runsOnActiveConnector}
                refresh={refreshRuns}
                scheduleRefresh={scheduleRunsRefresh}
              />
            </div>
          )}
        </>
      )}

      <div className="mt-6">
        {section === "log" && (
          <section data-testid="cp-message-log">
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <h3 className="text-sm font-semibold text-cx-fg">Message Log</h3>
              <span className="text-xs text-cx-muted">
                {tabLogs.length} {tabLogs.length === 1 ? "entry" : "entries"}
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleDownloadLogs}
                  title="Download every persisted log row for this CP as a JSON Lines file."
                >
                  Download
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleClearTabLogs("screen")}
                  title="Hide the currently-displayed log lines. Persisted history stays."
                >
                  Clear screen
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-cx-rose hover:text-cx-rose"
                  onClick={() => handleClearTabLogs("all")}
                  title="Hide the displayed lines AND delete persisted log rows for this CP."
                >
                  Clear screen + DB
                </Button>
                <Link
                  to={`/logs?cp=${encodeURIComponent(cpId)}`}
                  className="text-xs text-cx-accent hover:underline"
                >
                  Open in Message Log →
                </Link>
              </div>
            </div>
            <CompactLogList
              logs={tabLogs}
              className={isPanel ? "max-h-[340px]" : "max-h-[70vh]"}
            />
          </section>
        )}

        {section === "transactions" && (
          <section>
            <SectionHeader title="Transactions" backSearch={backToLogSearch} />
            <TransactionsTab cpId={cpId} />
          </section>
        )}

        {section === "analysis" && (
          <section>
            <SectionHeader
              title="Session analysis"
              backSearch={backToLogSearch}
            />
            <Suspense
              fallback={
                <div className="p-6 text-sm text-cx-muted">
                  Loading session analysis…
                </div>
              }
            >
              <SessionAnalysisPanel
                cpId={cpId}
                ocppVersion={resolvedOcppVersion}
              />
            </Suspense>
          </section>
        )}

        {section === "diagnostics" && (
          <section>
            <SectionHeader title="Diagnostics" backSearch={backToLogSearch} />
            {connectorList.length > 1 && (
              <select
                data-testid="diagnostics-connector"
                aria-label="Connector"
                value={activeConnectorId ?? ""}
                onChange={(e) => onSelectConnector(Number(e.target.value))}
                className={cn(FILTER_SELECT_CLASS, "mb-3")}
              >
                {connectorList.map((connector) => (
                  <option key={connector.id} value={connector.id}>
                    Connector {connector.id}
                  </option>
                ))}
              </select>
            )}
            {diagnosticsConnector && localCp ? (
              <div className="h-[520px]">
                <Suspense
                  fallback={
                    <div className="p-6 text-sm text-cx-muted">
                      Loading state diagram…
                    </div>
                  }
                >
                  <StateTransitionViewer
                    connector={diagnosticsConnector}
                    chargePoint={localCp}
                  />
                </Suspense>
              </div>
            ) : (
              <EmptyState
                title="State diagram unavailable"
                hint="The state transition diagram is available in local mode only."
              />
            )}
          </section>
        )}

        {section === "expert" && (
          <section>
            <SectionHeader title="Expert" backSearch={backToLogSearch} />
            <ExpertCallPanel
              cpId={cpId}
              ocppVersion={resolvedOcppVersion}
              connected={isConnected}
            />
          </section>
        )}

        {section === "network" && (
          <section>
            <SectionHeader
              title="Network simulation"
              backSearch={backToLogSearch}
            />
            <div className="rounded-[10px] border border-cx-border bg-cx-card p-4 shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none">
              {networkSimLoadError && (
                <div className="mb-4 rounded-md border border-cx-rose bg-cx-rose/10 p-3 text-sm text-cx-rose">
                  {networkSimLoadError}
                </div>
              )}
              {networkSimGlobalConfig === undefined && !networkSimLoadError && (
                <p className="text-sm text-cx-muted">
                  Loading network simulation…
                </p>
              )}
              {networkSimGlobalConfig != null && (
                <>
                  <NetworkSimEditor
                    mode="cp"
                    value={networkSimCpConfig ?? null}
                    inheritedRules={inheritedNetworkSimRules}
                    inheritedEnabled={networkSimGlobalConfig.enabled ?? false}
                    onSave={async (config) => {
                      try {
                        await chargePointService.saveNetworkSimCp(cpId, config);
                        await refreshNetworkSim();
                      } catch (err) {
                        console.error(
                          `Failed to save network sim config for ${cpId}`,
                          err,
                        );
                        throw err;
                      }
                    }}
                    onDeleteOverride={async () => {
                      try {
                        await chargePointService.saveNetworkSimCp(cpId, null);
                        await refreshNetworkSim();
                      } catch (err) {
                        console.error(
                          `Failed to delete network sim override for ${cpId}`,
                          err,
                        );
                        throw err;
                      }
                    }}
                  />
                  {snapshot?.networkSim?.manualRuleIds &&
                    snapshot.networkSim.manualRuleIds.length > 0 && (
                      <div className="mt-6 border-t border-cx-border pt-6">
                        <h3 className="mb-4 text-base font-semibold text-cx-fg">
                          Manual Rules
                        </h3>
                        <ManualDisconnectButtons
                          manualRuleIds={snapshot.networkSim.manualRuleIds}
                          isConnected={isConnected}
                          onTriggerDisconnect={async (ruleId) =>
                            chargePointService.triggerNetworkSimDisconnect(
                              cpId,
                              ruleId,
                            )
                          }
                        />
                      </div>
                    )}
                </>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

export default CpDetailContent;
