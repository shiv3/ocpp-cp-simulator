import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  lazy,
  Suspense,
} from "react";
import type { ChargePoint } from "../cp/domain/charge-point/ChargePoint";
import {
  ALL_CHARGE_POINT_ERROR_CODES,
  OCPPStatus,
} from "../cp/domain/types/OcppTypes";
import { ALLOWED_CONNECTOR_STATUS_TRANSITIONS } from "../cp/application/state/machines/ConnectorStateMachine";
import { useSocMeterSync } from "./hooks/useSocMeterSync";

/** True when the §4.9 transition table allows moving from `current` to Faulted.
 *  Used to decide whether to render the errorCode picker. */
function allowedNextIncludesFaulted(current: OCPPStatus): boolean {
  return (
    ALLOWED_CONNECTOR_STATUS_TRANSITIONS[current]?.includes(
      OCPPStatus.Faulted,
    ) ?? false
  );
}
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
} from "../cp/application/scenario/ScenarioTypes";
import { ScenarioManager } from "../cp/application/scenario/ScenarioManager";
import { createScenarioExecutorCallbacks } from "../cp/application/scenario/ScenarioRuntime";
import { useConnectorView } from "../data/hooks/useConnectorView";
import { useScenarios } from "../data/hooks/useScenarios";
import { useDataContext } from "../data/providers/DataProvider";
import type { AutoMeterValueConfig } from "../cp/domain/connector/MeterValueCurve";

// Dynamic imports for heavy components (bundle-dynamic-imports)
const StateTransitionViewer = lazy(
  () => import("./state-transition/StateTransitionViewer"),
);
const ScenarioEditor = lazy(() => import("./scenario/ScenarioEditor"));
const MeterValueCurveModal = lazy(() => import("./MeterValueCurveModal"));
import {
  ChevronRight,
  ChevronLeft,
  X,
  GitBranch,
  Zap,
  Gauge,
  Maximize2,
  Minimize2,
} from "lucide-react";

/** Which view to render on the right side of the panel. The connector
 *  controls always live on the left and are no longer a "tab". */
type TabType = "scenario" | "stateTransition";

/** Per-target tint so the buttons hint at what the destination means. */
const STATUS_BUTTON_STYLE: Readonly<Record<OCPPStatus, string>> = {
  [OCPPStatus.Available]:
    "border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60",
  [OCPPStatus.Preparing]:
    "border-sky-300 dark:border-sky-700 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900/60",
  [OCPPStatus.Charging]:
    "border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/60",
  [OCPPStatus.SuspendedEV]:
    "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/60",
  [OCPPStatus.SuspendedEVSE]:
    "border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-950/40 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-100 dark:hover:bg-yellow-900/60",
  [OCPPStatus.Finishing]:
    "border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/60",
  [OCPPStatus.Reserved]:
    "border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/60",
  [OCPPStatus.Unavailable]:
    "border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700",
  [OCPPStatus.Faulted]:
    "border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/60",
};

interface ConnectorSidePanelProps {
  cpId: string;
  connectorId: number;
  idTag: string;
  /** RFID tag IDs configured for this CP. Drives the Transaction TagID
   *  picker; falls back to a single-item list of `idTag` when empty. */
  tagIds?: string[];
  onClose: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  panelWidth: number;
  onWidthChange: (width: number) => void;
  /** Override which tab is shown when the panel opens or when this value
   *  changes (e.g. coming from the Connector's "Scenario Editor" button). */
  initialTab?: TabType;
  /** Increments when the caller wants to force the tab to re-apply
   *  `initialTab` even if the panel was already open. */
  tabResetNonce?: number;
}

// Helper component for status color
const getStatusColor = (status: string) => {
  switch (status) {
    case OCPPStatus.Available:
      return "bg-green-500";
    case OCPPStatus.Charging:
      return "bg-blue-500";
    case OCPPStatus.Preparing:
      return "bg-yellow-500";
    case OCPPStatus.Faulted:
      return "bg-red-500";
    case OCPPStatus.Unavailable:
      return "bg-gray-500";
    default:
      return "bg-gray-400";
  }
};

const clampMeterValue = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
};

// Collapsed Panel View
const CollapsedPanelView: React.FC<{
  connectorId: number;
  status: OCPPStatus;
  soc: number | null;
  onExpand: () => void;
  onClose: () => void;
}> = ({ connectorId, status, soc, onExpand, onClose }) => {
  return (
    <div className="h-full flex flex-col items-center py-4 px-2 bg-white dark:bg-gray-900">
      <button
        onClick={onExpand}
        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
        title="Expand panel"
      >
        <ChevronLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
      </button>
      <div className="mt-4 text-sm font-bold text-gray-900 dark:text-white">
        C{connectorId}
      </div>
      <div
        className={`mt-3 w-4 h-4 rounded-full ${getStatusColor(status)}`}
        title={status}
      />
      {soc !== null && (
        <div className="mt-3 text-xs font-mono text-gray-600 dark:text-gray-400">
          {soc.toFixed(0)}%
        </div>
      )}
      <button
        onClick={onClose}
        className="mt-auto p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
        title="Close panel"
      >
        <X className="w-5 h-5" />
      </button>
    </div>
  );
};

// Full Panel Content with Tabs
const FullPanelContent: React.FC<{
  cpId: string;
  connectorId: number;
  idTag: string;
  tagIds?: string[];
  onCollapse: () => void;
  onClose: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
  isResizing: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  initialTab?: TabType;
  tabResetNonce?: number;
}> = ({
  cpId,
  connectorId,
  idTag,
  tagIds,
  onCollapse,
  onClose,
  onResizeStart,
  isResizing,
  isFullscreen,
  onToggleFullscreen,
  initialTab,
  tabResetNonce,
}) => {
  const { chargePointService, mode, connectorSettingsRepository } =
    useDataContext();
  const localCp: ChargePoint | null =
    mode === "local" && chargePointService.getLocalChargePoint
      ? (chargePointService.getLocalChargePoint(cpId) as ChargePoint | null)
      : null;

  // Which view the right pane shows. Defaults to the Scenario editor; the
  // caller can force State Transition through initialTab.
  const [activeTab, setActiveTab] = useState<TabType>(
    initialTab === "stateTransition" ? "stateTransition" : "scenario",
  );
  // When the caller bumps tabResetNonce (or changes initialTab), jump back to
  // the requested tab. Lets the parent reopen the panel on a specific view.
  useEffect(() => {
    if (!initialTab) return;
    if (initialTab === "stateTransition") {
      setActiveTab("stateTransition");
    } else {
      // Legacy "details" / "scenario" both land on the scenario editor now.
      setActiveTab("scenario");
    }
  }, [initialTab, tabResetNonce]);
  const {
    status: connectorStatus,
    availability,
    meterValue: liveMeterValue,
    soc: liveSoc,
    transactionId,
    transactionStartTime: transactionStartDate,
    transactionTagId,
    autoMeterValueConfig,
    chargingProfile,
    chargingProfiles,
    evSettings,
  } = useConnectorView(cpId, connectorId);

  const { scenarios } = useScenarios(cpId, connectorId);
  const connector = localCp ? localCp.getConnector(connectorId) : null;
  const [meterValueInput, setMeterValueInput] = useState<number>(() =>
    clampMeterValue(liveMeterValue),
  );
  const [isMeterValueInputFocused, setIsMeterValueInputFocused] =
    useState(false);
  const [isMeterValueInputDirty, setIsMeterValueInputDirty] = useState(false);
  // Transaction TagID is always picked from the CP profile's configured
  // tagIds. Falls back to the single `idTag` when the parent didn't pass a
  // list (older callers / standalone usage).
  const availableTagIds =
    tagIds && tagIds.length > 0 ? tagIds : idTag ? [idTag] : [];
  const [tagIdInput, setTagIdInput] = useState<string>(
    availableTagIds[0] ?? idTag ?? "",
  );
  useEffect(() => {
    if (availableTagIds.length === 0) return;
    if (!availableTagIds.includes(tagIdInput)) {
      setTagIdInput(availableTagIds[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableTagIds.join("|")]);
  const [duration, setDuration] = useState<string>("00:00:00");
  const [transactionStartTime, setTransactionStartTime] = useState<string>("");
  const [isCurveModalOpen, setIsCurveModalOpen] = useState(false);
  // Selected ChargePointErrorCode applied when the operator clicks the
  // → Faulted button (§7.6). Defaults to InternalError because it's the
  // most generic non-NoError value.
  const [faultErrorCode, setFaultErrorCode] = useState<string>("InternalError");
  const { autoSyncSocMeter, handleToggleAutoSync, meterFromSoc, socFromMeter } =
    useSocMeterSync({
      chargePointService,
      connectorSettingsRepository,
      cpId,
      connectorId,
      evSettings,
    });

  const capacityKwh = evSettings.batteryCapacityKwh;
  const canAutoSync = autoSyncSocMeter && capacityKwh > 0;
  // Width of the left "Connector controls" column inside the Connector tab.
  // The user can drag the gutter between the controls and the Scenario
  // canvas to give more room to whichever side they're focused on.
  const [connectorColPx, setConnectorColPx] = useState<number>(280);
  const [isConnectorColResizing, setIsConnectorColResizing] = useState(false);
  const connectorColResizeStartX = useRef(0);
  const connectorColResizeStartWidth = useRef(280);

  const handleConnectorColResizeStart = (e: React.MouseEvent) => {
    setIsConnectorColResizing(true);
    connectorColResizeStartX.current = e.clientX;
    connectorColResizeStartWidth.current = connectorColPx;
    e.preventDefault();
  };

  useEffect(() => {
    if (!isConnectorColResizing) return;
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - connectorColResizeStartX.current;
      const next = Math.min(
        640,
        Math.max(200, connectorColResizeStartWidth.current + delta),
      );
      setConnectorColPx(next);
    };
    const onUp = () => setIsConnectorColResizing(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [isConnectorColResizing]);
  const profilesToDisplay =
    chargingProfiles.length > 0
      ? chargingProfiles
      : chargingProfile
        ? [chargingProfile]
        : [];
  const activeProfileId = chargingProfile?.chargingProfileId ?? null;

  // Scenario state
  const [scenario, setScenario] = useState<ScenarioDefinition | null>(null);
  const [scenarioExecutionContext, setScenarioExecutionContext] =
    useState<ScenarioExecutionContext | null>(null);
  const [nodeProgress, setNodeProgress] = useState<
    Record<string, { remaining: number; total: number }>
  >({});
  const scenarioManagerRef = useRef<ScenarioManager | null>(null);
  const scenarioRef = useRef<ScenarioDefinition | null>(null);
  const [remoteScenarioListError, setRemoteScenarioListError] = useState(false);
  const [remoteScenarioStatusError, setRemoteScenarioStatusError] =
    useState(false);

  useEffect(() => {
    const nextLiveMeterValue = clampMeterValue(liveMeterValue);
    if (!isMeterValueInputFocused && !isMeterValueInputDirty) {
      setMeterValueInput(nextLiveMeterValue);
      return;
    }
    if (!isMeterValueInputFocused && meterValueInput === nextLiveMeterValue) {
      setIsMeterValueInputDirty(false);
    }
  }, [
    isMeterValueInputDirty,
    isMeterValueInputFocused,
    liveMeterValue,
    meterValueInput,
  ]);

  // Track transaction duration
  useEffect(() => {
    if (connectorStatus !== OCPPStatus.Charging || !transactionStartDate) {
      setDuration("00:00:00");
      setTransactionStartTime("");
      return;
    }

    setTransactionStartTime(transactionStartDate.toLocaleTimeString());

    const interval = setInterval(() => {
      const elapsed = Date.now() - transactionStartDate.getTime();
      const hours = Math.floor(elapsed / 3600000);
      const minutes = Math.floor((elapsed % 3600000) / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      setDuration(
        `${hours.toString().padStart(2, "0")}:${minutes
          .toString()
          .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`,
      );
    }, 1000);

    return () => clearInterval(interval);
  }, [connectorStatus, transactionStartDate]);

  // Setup ScenarioManager
  useEffect(() => {
    scenarioRef.current = scenario;
  }, [scenario]);

  useEffect(() => {
    if (!localCp || !connector) return;

    // Reuse the existing ScenarioManager if the connector card already
    // created one. Replacing it would kill any in-flight scenario AND
    // reset the auto-start dedup key, which is exactly the bug the user
    // saw when opening the side panel mid-scenario. We only create a new
    // manager when none exists (e.g. remote mode, or a connector that
    // somehow lost its manager).
    let manager = connector.scenarioManager;
    let ownsManager = false;
    if (!manager) {
      const callbacks = createScenarioExecutorCallbacks({
        chargePoint: localCp,
        connector,
        hooks: {
          onNodeProgress: (nodeId, remaining, total) => {
            setNodeProgress((prev) => ({
              ...prev,
              [nodeId]: { remaining, total },
            }));
          },
          onStateChange: (context) => {
            const currentScenario = scenarioRef.current;
            if (currentScenario && context.scenarioId === currentScenario.id) {
              setScenarioExecutionContext(context);
            }
          },
        },
      });
      manager = new ScenarioManager(
        connector,
        localCp,
        callbacks,
        connector.scenarioEvents,
      );
      connector.setScenarioManager(manager);
      ownsManager = true;
    }
    scenarioManagerRef.current = manager;

    // Per-tick poll keeps the side-panel UI in sync with whichever scenario
    // is currently running. Works regardless of whether the manager was
    // created here or by the connector card — `getScenarioExecutionContext`
    // is the same on both.
    const intervalId = setInterval(() => {
      const activeManager = scenarioManagerRef.current;
      if (!activeManager) return;
      const activeIds = activeManager.getActiveScenarioIds();
      const currentScenario = scenarioRef.current;
      if (currentScenario && activeIds.includes(currentScenario.id)) {
        const context = activeManager.getScenarioExecutionContext(
          currentScenario.id,
        );
        setScenarioExecutionContext(context);
      } else {
        setScenarioExecutionContext(null);
      }
    }, 500);

    return () => {
      clearInterval(intervalId);
      // Only destroy the manager if THIS effect created it. If we reused
      // the connector's existing manager (created by the connector card),
      // leave it alive — the card still depends on it.
      if (ownsManager) {
        manager.destroy();
      }
      scenarioManagerRef.current = null;
    };
  }, [connector, localCp, connectorId]);

  // Remote mode: the scenario runs on the daemon, so there is no local
  // ScenarioManager to poll. The daemon streams `scenario-node-execute`
  // events over the events WebSocket — replay them into a synthetic
  // ScenarioExecutionContext so the editor highlights the same way as in
  // local mode. We also seed the context from `getScenarioStatus` on mount
  // / scenario change so an already-running scenario shows up immediately.
  useEffect(() => {
    if (mode !== "remote") return;
    const targetScenarioId = scenario?.id;
    if (!targetScenarioId) {
      setRemoteScenarioStatusError(false);
      setScenarioExecutionContext(null);
      return;
    }

    let cancelled = false;
    void chargePointService
      .getScenarioStatus(cpId, connectorId, targetScenarioId)
      .then((ctx) => {
        if (cancelled) return;
        setRemoteScenarioStatusError(false);
        setScenarioExecutionContext(ctx);
      })
      .catch((err) => {
        if (cancelled) return;
        setRemoteScenarioStatusError(true);
        console.warn(
          `[ConnectorSidePanel] Failed to fetch remote scenario status for ${cpId}/${connectorId}/${targetScenarioId}`,
          err,
        );
      });

    const unsub = chargePointService.subscribe(cpId, (event) => {
      if (!("connectorId" in event) || event.connectorId !== connectorId) {
        return;
      }
      if (event.type === "scenario-started") {
        if (event.scenarioId !== targetScenarioId) return;
        setScenarioExecutionContext({
          scenarioId: event.scenarioId,
          state: "running",
          mode: "oneshot",
          currentNodeId: null,
          executedNodes: [],
          loopCount: 0,
        });
      } else if (event.type === "scenario-node-execute") {
        if (event.scenarioId !== targetScenarioId) return;
        setScenarioExecutionContext((prev) => {
          const base: ScenarioExecutionContext =
            prev && prev.scenarioId === targetScenarioId
              ? prev
              : {
                  scenarioId: targetScenarioId,
                  state: "running",
                  mode: "oneshot",
                  currentNodeId: null,
                  executedNodes: [],
                  loopCount: 0,
                };
          const executed = base.executedNodes.includes(event.nodeId)
            ? base.executedNodes
            : [...base.executedNodes, event.nodeId];
          return {
            ...base,
            currentNodeId: event.nodeId,
            executedNodes: executed,
          };
        });
      } else if (
        event.type === "scenario-completed" ||
        event.type === "scenario-error"
      ) {
        if (event.scenarioId !== targetScenarioId) return;
        setScenarioExecutionContext(null);
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [mode, cpId, connectorId, scenario?.id, chargePointService]);

  // Load scenarios from the repository (local mode). Remote mode is hydrated
  // by the dedicated effect below — skip this path so the local default
  // doesn't clobber the server-loaded template.
  useEffect(() => {
    if (mode !== "local") return;

    if (scenarios.length > 0) {
      setScenario((current) => {
        // If the currently-selected scenario is still present, keep the
        // *existing* reference. ScenarioEditor owns its working state and
        // re-hydrates whenever this prop ref changes; pushing a fresh
        // object of the same id here would clobber in-flight edits and
        // trigger an auto-save → repository-notify → setScenario loop.
        if (current && scenarios.some((s) => s.id === current.id)) {
          return current;
        }
        const next = scenarios[0];
        scenarioRef.current = next;
        return next;
      });
    } else {
      setScenario(null);
      scenarioRef.current = null;
    }

    const manager = scenarioManagerRef.current;
    if (manager) {
      manager.loadScenarios(scenarios);
    }
  }, [mode, scenarios]);

  // Remote mode: hydrate the editor with scenarios the daemon has loaded
  // (e.g. via --scenario-template-file). Refetch on scenario lifecycle
  // events so newly loaded templates appear without a manual reload.
  useEffect(() => {
    if (mode !== "remote") return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const list = await chargePointService.listScenarios(cpId, connectorId);
        if (cancelled) return;
        setRemoteScenarioListError(false);
        if (list.length === 0) return;
        const defs = await Promise.all(
          list.map((item) =>
            chargePointService
              .getScenario(cpId, connectorId, item.scenarioId)
              .catch(() => null),
          ),
        );
        if (cancelled) return;
        const valid = defs.filter((d): d is ScenarioDefinition => d !== null);
        if (valid.length === 0) return;
        setScenario((current) => {
          if (current) {
            const match = valid.find((s) => s.id === current.id);
            if (match) return match;
          }
          // Prefer an active scenario, otherwise the first loaded one.
          const activeItem = list.find((item) => item.active);
          const preferred = activeItem
            ? valid.find((d) => d.id === activeItem.scenarioId)
            : null;
          const next = preferred ?? valid[0];
          scenarioRef.current = next;
          return next;
        });
      } catch (err) {
        if (!cancelled) {
          setRemoteScenarioListError(true);
          console.warn(
            `[ConnectorSidePanel] Failed to fetch remote scenarios for ${cpId}/${connectorId}`,
            err,
          );
        }
      }
    };

    void refresh();
    const unsub = chargePointService.subscribe(cpId, (event) => {
      if (
        (event.type === "scenario-started" ||
          event.type === "scenario-completed") &&
        event.connectorId === connectorId
      ) {
        void refresh();
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [mode, cpId, connectorId, chargePointService]);

  // Handlers — single toggle drives both directions to match the connector
  // card. We read the live `isCharging` at click time (passed in) so the
  // label and action stay consistent if state changed elsewhere.
  const handleTransactionToggle = useCallback(
    (isChargingNow: boolean) => {
      if (isChargingNow) {
        void chargePointService.stopTransaction(cpId, connectorId);
      } else if (tagIdInput) {
        void chargePointService.startTransaction(cpId, connectorId, tagIdInput);
      }
    },
    [chargePointService, cpId, connectorId, tagIdInput],
  );

  const handleIncreaseMeterValue = useCallback(() => {
    const nextValue = clampMeterValue(meterValueInput + 10);
    setMeterValueInput(nextValue);
    setIsMeterValueInputDirty(false);
    void chargePointService.setMeterValue(cpId, connectorId, nextValue);
    if (canAutoSync) {
      void chargePointService.setConnectorSoc(
        cpId,
        connectorId,
        socFromMeter(nextValue),
      );
    }
  }, [
    chargePointService,
    cpId,
    connectorId,
    meterValueInput,
    canAutoSync,
    socFromMeter,
  ]);

  const handleSendMeterValue = useCallback(() => {
    const nextValue = clampMeterValue(meterValueInput);
    setMeterValueInput(nextValue);
    setIsMeterValueInputDirty(false);
    void chargePointService
      .setMeterValue(cpId, connectorId, nextValue)
      .then(() => chargePointService.sendMeterValue(cpId, connectorId));
    if (canAutoSync) {
      void chargePointService.setConnectorSoc(
        cpId,
        connectorId,
        socFromMeter(nextValue),
      );
    }
  }, [
    chargePointService,
    cpId,
    connectorId,
    meterValueInput,
    canAutoSync,
    socFromMeter,
  ]);

  // Sets SoC and, when auto-sync is enabled, mirrors a derived meter value
  // (initialSoc + delta% × capacity). Passing `null` clears SoC; in that
  // case we leave the meter alone since "no SoC sample" doesn't imply a
  // meter reset.
  const handleSetSoc = useCallback(
    (next: number | null) => {
      void chargePointService.setConnectorSoc(cpId, connectorId, next);
      if (next !== null && canAutoSync) {
        const derivedMeter = meterFromSoc(next);
        setMeterValueInput(derivedMeter);
        setIsMeterValueInputDirty(false);
        void chargePointService.setMeterValue(cpId, connectorId, derivedMeter);
      }
    },
    [chargePointService, cpId, connectorId, canAutoSync, meterFromSoc],
  );

  // The Auto MeterValue curve editor still lives inside the scenario's
  // MeterValue node (double-click → MeterValueCurveModal). The connector
  // side keeps the saver so scenarios can persist a curve back to local
  // storage when applicable.
  const handleSaveAutoMeterValueConfig = useCallback(
    (config: AutoMeterValueConfig) => {
      void chargePointService.setAutoMeterValueConfig(
        cpId,
        connectorId,
        config,
      );
      if (mode === "local") {
        // Persist through the repository so the next ChargePoint
        // construction picks it up out of SQLite (handled by
        // LocalChargePointService.buildChargePoint).
        void connectorSettingsRepository.saveAutoMeterValueConfig(
          cpId,
          connectorId,
          config,
        );
      }
    },
    [chargePointService, connectorSettingsRepository, cpId, connectorId, mode],
  );

  const isCharging = connectorStatus === OCPPStatus.Charging;
  const showRemoteScenarioError =
    mode === "remote" && (remoteScenarioListError || remoteScenarioStatusError);

  return (
    <div className="h-full flex flex-row bg-white dark:bg-gray-900">
      {/* Resize Handle — hidden in fullscreen since the panel covers 100vw. */}
      {!isFullscreen && (
        <div
          className={`w-2 bg-gray-200 dark:bg-gray-700 hover:bg-blue-500 dark:hover:bg-blue-400 cursor-col-resize flex-shrink-0 transition-colors ${
            isResizing ? "bg-blue-500 dark:bg-blue-400" : ""
          }`}
          onMouseDown={onResizeStart}
        >
          <div className="w-full h-full flex items-center justify-center">
            <div className="w-0.5 h-12 bg-gray-400 dark:bg-gray-500 rounded-full" />
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top action bar — collapse / spacer / fullscreen / close. The
            connector controls always live on the left; right-pane view is
            switched via the in-pane tab strip below. */}
        <div className="border-b border-gray-200 dark:border-gray-700 flex-shrink-0 bg-gray-50 dark:bg-gray-800">
          <div className="flex items-center">
            <button
              onClick={onCollapse}
              className="p-3 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              title="Collapse panel"
            >
              <ChevronRight className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            </button>
            <div className="flex-1 px-4 py-3 text-sm font-semibold text-gray-700 dark:text-gray-200 flex items-center gap-2">
              <Zap className="w-4 h-4 text-blue-500" />
              Connector {connectorId}
              <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
                · {cpId}
              </span>
            </div>
            <button
              onClick={onToggleFullscreen}
              className="p-3 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            >
              {isFullscreen ? (
                <Minimize2 className="w-5 h-5" />
              ) : (
                <Maximize2 className="w-5 h-5" />
              )}
            </button>
            <button
              onClick={onClose}
              className="p-3 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              title="Close panel"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body — left column always shows connector controls, right
            column switches between Scenario Editor and State Transition
            via its own tab strip. */}
        <div className="flex-1 overflow-hidden">
          <div
            className={`h-full flex flex-row ${
              isConnectorColResizing ? "select-none cursor-col-resize" : ""
            }`}
          >
            {/* Left column: connector controls (resizable, scrollable). */}
            <div
              className="flex-shrink-0 overflow-y-auto p-3 space-y-3"
              style={{ width: `${connectorColPx}px` }}
            >
              {/* Header */}
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                    Connector {connectorId}
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {cpId}
                  </p>
                </div>
              </div>

              {/* Status strip — three compact pills. */}
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="bg-gray-50 dark:bg-gray-800 rounded p-2">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Status
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span
                      className={`w-2 h-2 rounded-full ${getStatusColor(connectorStatus)}`}
                    />
                    <span className="font-semibold text-gray-900 dark:text-white">
                      {connectorStatus}
                    </span>
                  </div>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 rounded p-2">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Meter
                  </div>
                  <div className="font-mono font-semibold text-gray-900 dark:text-white mt-0.5">
                    {liveMeterValue.toLocaleString()}
                    <span className="text-[10px] text-gray-500 dark:text-gray-400 ml-1">
                      Wh
                    </span>
                  </div>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 rounded p-2">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Availability
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span
                      className={`w-2 h-2 rounded-full ${availability === "Operative" ? "bg-green-500" : "bg-red-500"}`}
                    />
                    <span className="font-semibold text-gray-900 dark:text-white">
                      {availability}
                    </span>
                  </div>
                </div>
              </div>

              {/* Active Transaction */}
              {isCharging && transactionId !== null && transactionId !== 0 && (
                <div className="bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-950/50 dark:to-emerald-950/50 rounded-lg p-4 border-l-4 border-green-500">
                  <h3 className="text-sm font-semibold mb-3 text-green-700 dark:text-green-300 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    Active Transaction
                  </h3>
                  <div className="text-2xl font-bold font-mono text-green-800 dark:text-green-200 mb-3">
                    #{transactionId}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs text-green-600 dark:text-green-400">
                        ID Tag
                      </span>
                      <span
                        className="font-mono font-medium text-green-800 dark:text-green-200 truncate"
                        title={transactionTagId || tagIdInput}
                      >
                        {transactionTagId || tagIdInput || "—"}
                      </span>
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs text-green-600 dark:text-green-400">
                        Started
                      </span>
                      <span className="font-mono font-medium text-green-800 dark:text-green-200 truncate">
                        {transactionStartTime}
                      </span>
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs text-green-600 dark:text-green-400">
                        Duration
                      </span>
                      <span className="font-mono font-medium text-green-800 dark:text-green-200 truncate">
                        {duration}
                      </span>
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs text-green-600 dark:text-green-400">
                        Energy
                      </span>
                      <span className="font-mono font-medium text-green-800 dark:text-green-200 truncate">
                        {(liveMeterValue / 1000).toFixed(2)} kWh
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Transaction — TagID is always a select sourced from the CP
                  profile's `tagIds`, and one toggle button covers Start/Stop
                  (label/style flips with isCharging). Matches the connector
                  card so operators get the same controls in both surfaces. */}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Transaction
                </h4>
                <select
                  value={
                    availableTagIds.includes(tagIdInput)
                      ? tagIdInput
                      : (availableTagIds[0] ?? "")
                  }
                  onChange={(e) => setTagIdInput(e.target.value)}
                  disabled={isCharging || availableTagIds.length === 0}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-60"
                  title="Switch RFID tag profile before starting a transaction"
                >
                  {availableTagIds.length === 0 ? (
                    <option value="">No TagIDs configured</option>
                  ) : (
                    availableTagIds.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))
                  )}
                </select>
                <button
                  onClick={() => handleTransactionToggle(isCharging)}
                  disabled={!isCharging && !tagIdInput}
                  className={`w-full text-sm py-2 px-3 font-medium text-white rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
                    isCharging
                      ? "bg-yellow-500 hover:bg-yellow-600"
                      : "bg-green-500 hover:bg-green-600"
                  }`}
                >
                  {isCharging ? "Stop" : "Start"}
                </button>
              </div>

              {/* Battery — unified card combining Live SoC (% — battery
                  charge level reported in MeterValues SoC samples) and
                  Meter Value (Wh — cumulative energy counter sent in
                  MeterValues). They share this card because both feed into
                  the same OCPP MeterValues message, just as different
                  measurands. Vertical bar fills bottom-up with SoC; the
                  target-SoC marker (from evSettings) crosses the bar. */}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                    <span aria-hidden>🔋</span> Battery
                  </h4>
                  <label
                    className={`flex items-center gap-1 text-[10px] cursor-pointer select-none ${
                      capacityKwh > 0
                        ? "text-gray-600 dark:text-gray-300"
                        : "text-gray-400 dark:text-gray-600 cursor-not-allowed"
                    }`}
                    title={
                      capacityKwh > 0
                        ? "Keep SoC % and Meter Wh in sync using the EV battery capacity"
                        : "Set evSettings.batteryCapacityKwh > 0 to enable sync"
                    }
                  >
                    <input
                      type="checkbox"
                      checked={autoSyncSocMeter && capacityKwh > 0}
                      onChange={handleToggleAutoSync}
                      disabled={capacityKwh <= 0}
                      className="w-3 h-3"
                    />
                    Sync SoC ↔ Meter
                  </label>
                </div>
                <div className="text-[11px] text-gray-500 dark:text-gray-400">
                  {liveSoc !== null
                    ? `${liveSoc.toFixed(1)}%`
                    : "SoC not reported"}
                  {" · "}
                  {(liveMeterValue / 1000).toFixed(2)} kWh
                  {` · target ${evSettings.targetSoc}%`}
                </div>

                <div className="flex gap-3 items-stretch">
                  {/* Vertical battery bar (fills bottom-up to SoC%). */}
                  <div className="relative w-10 flex-shrink-0 rounded-md bg-gray-200 dark:bg-gray-700 overflow-hidden border border-gray-300 dark:border-gray-600">
                    {/* fill */}
                    <div
                      className={`absolute left-0 right-0 bottom-0 transition-[height] duration-200 ${
                        isCharging
                          ? "bg-gradient-to-t from-green-500 to-emerald-400"
                          : "bg-gradient-to-t from-blue-500 to-sky-400"
                      }`}
                      style={{ height: `${Math.round(liveSoc ?? 0)}%` }}
                      aria-hidden
                    />
                    {/* target marker */}
                    {evSettings.targetSoc != null && (
                      <div
                        className="absolute left-0 right-0 border-t-2 border-dashed border-amber-500"
                        style={{
                          bottom: `${evSettings.targetSoc}%`,
                        }}
                        title={`Target ${evSettings.targetSoc}%`}
                        aria-hidden
                      />
                    )}
                    {/* big SoC % overlay */}
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-[11px] font-bold font-mono text-gray-900 dark:text-white drop-shadow-[0_1px_1px_rgba(255,255,255,0.6)] dark:drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">
                        {liveSoc !== null ? `${Math.round(liveSoc)}%` : "—"}
                      </span>
                    </div>
                  </div>

                  {/* Right side controls */}
                  <div className="flex-1 min-w-0 space-y-2">
                    {/* SoC slider + nudge buttons */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400">
                        <span>SoC</span>
                        <span>%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={Math.round(liveSoc ?? 0)}
                        onChange={(e) =>
                          handleSetSoc(parseInt(e.target.value, 10))
                        }
                        className="w-full"
                      />
                      <div className="grid grid-cols-5 gap-1">
                        {[-10, -1, +1, +10].map((delta) => (
                          <button
                            key={delta}
                            type="button"
                            onClick={() => {
                              const base = liveSoc ?? 0;
                              const next = Math.min(
                                100,
                                Math.max(0, base + delta),
                              );
                              handleSetSoc(next);
                            }}
                            className="px-1 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
                          >
                            {delta > 0 ? `+${delta}` : delta}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => handleSetSoc(null)}
                          title="Clear SoC (next MeterValue omits the SoC sample)"
                          className="px-1 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 transition-colors"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Meter (Wh) — the cumulative energy counter. Sits inside
                    the Battery card because it's the other half of the same
                    MeterValues message. */}
                <div className="space-y-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                  <div className="flex items-center justify-between text-[10px] text-gray-500 dark:text-gray-400">
                    <span>Meter (energy counter)</span>
                    <span>Wh</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={0}
                      value={meterValueInput}
                      onFocus={() => setIsMeterValueInputFocused(true)}
                      onBlur={() => setIsMeterValueInputFocused(false)}
                      onChange={(e) => {
                        setIsMeterValueInputDirty(true);
                        setMeterValueInput(
                          clampMeterValue(Number(e.target.value)),
                        );
                      }}
                      className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono"
                    />
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      Wh
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={handleIncreaseMeterValue}
                      className="text-sm py-2 px-3 font-medium bg-blue-500 hover:bg-blue-600 text-white rounded transition-colors"
                    >
                      +10 Wh
                    </button>
                    <button
                      onClick={handleSendMeterValue}
                      className="text-sm py-2 px-3 font-medium bg-gray-500 hover:bg-gray-600 text-white rounded transition-colors"
                    >
                      Send
                    </button>
                  </div>
                </div>
              </div>

              {/* Status Control — only the next states reachable from the
                  current status via the OCPP 1.6 connector state diagram
                  (mirrors src/cp/application/state/machines/ConnectorStateMachine.ts).
                  This stops users from sending invalid transitions like
                  Available → Charging by accident. The Faulted button picks
                  up the errorCode from the picker below. */}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Status Control
                  </h4>
                  <span className="text-[10px] text-gray-400 dark:text-gray-500">
                    next states
                  </span>
                </div>
                {(() => {
                  const allowedNext =
                    ALLOWED_CONNECTOR_STATUS_TRANSITIONS[connectorStatus] ?? [];
                  if (allowedNext.length === 0) {
                    return (
                      <p className="text-xs text-gray-400 dark:text-gray-500 italic">
                        No transitions defined from this state.
                      </p>
                    );
                  }
                  return (
                    <div className="grid grid-cols-2 gap-1.5">
                      {allowedNext.map((target) => (
                        <button
                          key={target}
                          type="button"
                          onClick={() =>
                            void chargePointService.sendStatusNotification(
                              cpId,
                              connectorId,
                              target,
                              target === OCPPStatus.Faulted
                                ? { errorCode: faultErrorCode }
                                : undefined,
                            )
                          }
                          className={`px-2 py-1.5 text-xs font-medium rounded border transition-colors ${STATUS_BUTTON_STYLE[target]}`}
                        >
                          → {target}
                        </button>
                      ))}
                    </div>
                  );
                })()}
                {allowedNextIncludesFaulted(connectorStatus) && (
                  <div className="flex items-center gap-1 pt-1">
                    <label className="text-[10px] text-gray-500 dark:text-gray-400">
                      Fault errorCode:
                    </label>
                    <select
                      className="flex-1 text-xs border border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      value={faultErrorCode}
                      onChange={(e) => setFaultErrorCode(e.target.value)}
                    >
                      {ALL_CHARGE_POINT_ERROR_CODES.filter(
                        (c) => c !== "NoError",
                      ).map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Charging Profile (collapsible, default closed) */}
              <details className="bg-gray-50 dark:bg-gray-800 rounded-lg group">
                <summary className="cursor-pointer p-3 text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2 select-none">
                  <Gauge className="w-4 h-4 text-indigo-500" />
                  Charging Profile
                  <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
                    {profilesToDisplay.length}
                  </span>
                </summary>
                <div className="px-4 pb-4">
                  {profilesToDisplay.length > 0 ? (
                    <div className="space-y-4">
                      {profilesToDisplay.map((profile) => {
                        const isPaused = profile.chargingSchedulePeriods.every(
                          (p) => p.limit === 0,
                        );
                        const isActive =
                          activeProfileId === profile.chargingProfileId;
                        return (
                          <div key={profile.chargingProfileId}>
                            <div
                              className={`rounded-lg p-3 mb-3 ${
                                isPaused
                                  ? "bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800"
                                  : "bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800"
                              }`}
                            >
                              <div className="flex items-center justify-between mb-2">
                                <span
                                  className={`text-xs font-bold ${
                                    isPaused
                                      ? "text-orange-700 dark:text-orange-300"
                                      : "text-indigo-700 dark:text-indigo-300"
                                  }`}
                                >
                                  {isPaused ? "⏸ Paused" : "⚡ Active"}
                                  {isActive ? " · Current" : " · Stored"}
                                </span>
                                <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                                  #{profile.chargingProfileId}
                                </span>
                              </div>
                              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                                <span className="text-gray-500 dark:text-gray-400">
                                  Purpose
                                </span>
                                <span className="font-medium text-gray-800 dark:text-gray-200 truncate">
                                  {profile.chargingProfilePurpose}
                                </span>
                                <span className="text-gray-500 dark:text-gray-400">
                                  Kind
                                </span>
                                <span className="font-medium text-gray-800 dark:text-gray-200">
                                  {profile.chargingProfileKind}
                                </span>
                                <span className="text-gray-500 dark:text-gray-400">
                                  Stack Level
                                </span>
                                <span className="font-medium text-gray-800 dark:text-gray-200">
                                  {profile.stackLevel}
                                </span>
                                <span className="text-gray-500 dark:text-gray-400">
                                  Unit
                                </span>
                                <span className="font-medium text-gray-800 dark:text-gray-200">
                                  {profile.chargingRateUnit}
                                </span>
                              </div>
                            </div>
                            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
                              Schedule Periods
                            </div>
                            <div className="space-y-1">
                              {profile.chargingSchedulePeriods.map(
                                (period, idx) => (
                                  <div
                                    key={idx}
                                    className="flex items-center justify-between bg-white dark:bg-gray-700 rounded px-2.5 py-1.5 text-xs"
                                  >
                                    <span className="text-gray-500 dark:text-gray-400">
                                      @{period.startPeriod}s
                                    </span>
                                    <span
                                      className={`font-bold font-mono ${
                                        period.limit === 0
                                          ? "text-orange-600 dark:text-orange-400"
                                          : "text-indigo-600 dark:text-indigo-400"
                                      }`}
                                    >
                                      {period.limit} {profile.chargingRateUnit}
                                    </span>
                                    {period.numberPhases != null && (
                                      <span className="text-gray-400 dark:text-gray-500">
                                        {period.numberPhases}φ
                                      </span>
                                    )}
                                  </div>
                                ),
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-500 dark:text-gray-400 py-1 space-y-1">
                      <div className="italic">No active charging profile.</div>
                      <div className="text-gray-400 dark:text-gray-500">
                        The connector charges at its unrestricted auto-meter
                        rate until a SetChargingProfile.req arrives from the
                        CSMS.
                      </div>
                    </div>
                  )}
                </div>
              </details>
            </div>
            {/* Vertical resize handle between controls and canvas. */}
            <div
              role="separator"
              aria-orientation="vertical"
              onMouseDown={handleConnectorColResizeStart}
              className={`w-1 cursor-col-resize flex-shrink-0 transition-colors border-r border-gray-200 dark:border-gray-700 hover:bg-blue-500 dark:hover:bg-blue-400 ${
                isConnectorColResizing
                  ? "bg-blue-500 dark:bg-blue-400"
                  : "bg-transparent"
              }`}
              title="Drag to resize"
            />
            {/* Right column: tab strip switching between the scenario
                  editor and the OCPP state-transition diagram. */}
            <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
              <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex items-center">
                <button
                  onClick={() => setActiveTab("scenario")}
                  className={`px-4 py-2 text-sm font-medium transition-colors flex items-center gap-2 ${
                    activeTab === "scenario"
                      ? "bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
                      : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                  }`}
                >
                  <Zap className="w-4 h-4" />
                  Scenario Editor
                </button>
                <button
                  onClick={() => setActiveTab("stateTransition")}
                  className={`px-4 py-2 text-sm font-medium transition-colors flex items-center gap-2 ${
                    activeTab === "stateTransition"
                      ? "bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
                      : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                  }`}
                >
                  <GitBranch className="w-4 h-4" />
                  State Transition
                </button>
              </div>
              {/* Both views stay mounted; only their visibility changes.
                    Unmounting ScenarioEditor when the user peeks at State
                    Transition would drop its in-component auto-start guard
                    (a useRef) and the scenario would auto-start again on
                    re-mount.

                    `hidden` (display: none) is used instead of `invisible`
                    because React Flow's internal nodes set
                    `visibility: visible` explicitly, which beats parent
                    `visibility: hidden` via CSS specificity. `display:
                    none` collapses the inactive view's subtree entirely
                    without unmounting the React component. */}
              <div className="flex-1 min-h-0 overflow-hidden relative">
                <div
                  className={`absolute inset-0 h-full flex flex-col ${
                    activeTab === "scenario" ? "" : "hidden"
                  }`}
                  aria-hidden={activeTab !== "scenario"}
                >
                  {showRemoteScenarioError && (
                    <div className="flex-shrink-0 mx-3 mt-3 rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                      Couldn't reach the daemon. Scenario data is unavailable.
                    </div>
                  )}
                  <div className="flex-1 min-h-0">
                    <Suspense
                      fallback={
                        <div className="h-full flex items-center justify-center">
                          <div className="text-muted">
                            Loading Scenario Editor...
                          </div>
                        </div>
                      }
                    >
                      <ScenarioEditor
                        cpId={cpId}
                        connectorId={connectorId}
                        scenario={scenario}
                        scenarioId={scenario?.id}
                        executionContext={scenarioExecutionContext}
                        nodeProgress={nodeProgress}
                        onClose={() => setActiveTab("scenario")}
                      />
                    </Suspense>
                  </div>
                </div>
                <div
                  className={`absolute inset-0 ${
                    activeTab === "stateTransition" ? "" : "hidden"
                  }`}
                  aria-hidden={activeTab !== "stateTransition"}
                >
                  {connector && localCp ? (
                    <div className="h-full flex flex-col">
                      <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          OCPP 1.6J state machine for Connector {connectorId}
                        </p>
                      </div>
                      <div className="flex-1 min-h-0">
                        <Suspense
                          fallback={
                            <div className="h-full flex items-center justify-center">
                              <div className="text-muted">
                                Loading State Diagram...
                              </div>
                            </div>
                          }
                        >
                          <StateTransitionViewer
                            connector={connector}
                            chargePoint={localCp}
                          />
                        </Suspense>
                      </div>
                    </div>
                  ) : (
                    <div className="h-full flex items-center justify-center text-muted">
                      State transition diagram is available in local mode only.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {isCurveModalOpen && autoMeterValueConfig ? (
        <Suspense
          fallback={
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center">
              <div className="text-white">Loading...</div>
            </div>
          }
        >
          <MeterValueCurveModal
            isOpen={isCurveModalOpen}
            onClose={() => setIsCurveModalOpen(false)}
            initialConfig={autoMeterValueConfig}
            onSave={handleSaveAutoMeterValueConfig}
          />
        </Suspense>
      ) : null}
    </div>
  );
};

export const ConnectorSidePanel: React.FC<ConnectorSidePanelProps> = ({
  cpId,
  connectorId,
  idTag,
  tagIds,
  onClose,
  isCollapsed,
  onToggleCollapse,
  isFullscreen,
  onToggleFullscreen,
  panelWidth,
  onWidthChange,
  initialTab,
  tabResetNonce,
}) => {
  const { status, soc } = useConnectorView(cpId, connectorId);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  // Handle resize
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      setIsResizing(true);
      resizeStartX.current = e.clientX;
      resizeStartWidth.current = panelWidth;
      e.preventDefault();
    },
    [panelWidth],
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = resizeStartX.current - e.clientX;
      const viewportWidth = window.innerWidth;
      const deltaVw = (deltaX / viewportWidth) * 100;
      const newWidth = Math.min(
        90,
        Math.max(25, resizeStartWidth.current + deltaVw),
      );
      onWidthChange(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, onWidthChange]);

  if (isCollapsed) {
    return (
      <CollapsedPanelView
        connectorId={connectorId}
        status={status}
        soc={soc}
        onExpand={onToggleCollapse}
        onClose={onClose}
      />
    );
  }

  return (
    <FullPanelContent
      cpId={cpId}
      connectorId={connectorId}
      idTag={idTag}
      tagIds={tagIds}
      onCollapse={onToggleCollapse}
      onClose={onClose}
      onResizeStart={handleResizeStart}
      isResizing={isResizing}
      isFullscreen={isFullscreen}
      onToggleFullscreen={onToggleFullscreen}
      initialTab={initialTab}
      tabResetNonce={tabResetNonce}
    />
  );
};

export default ConnectorSidePanel;
