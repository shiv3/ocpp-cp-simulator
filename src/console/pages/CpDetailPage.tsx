import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link, useParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import { LogViewer } from "@/components/ui/log-viewer";
import ChargePointConfigModal, {
  defaultChargePointConfig,
  type ChargePointConfig,
} from "@/components/ChargePointConfigModal";
import { getConfigBasicAuthPassword } from "@/data/configPort";
import { useChargePointView } from "@/data/hooks/useChargePointView";
import { useConfig } from "@/data/hooks/useConfig";
import { useDataContext } from "@/data/providers/DataProvider";
import type { ChargePointSnapshot } from "@/data/interfaces/ChargePointService";
import type { WireSimulatorConfig } from "@/protocol";
import type { ChargePoint } from "@/cp/domain/charge-point/ChargePoint";
import { OCPPStatus } from "@/cp/domain/types/OcppTypes";

import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import StatusPill from "../components/StatusPill";
import ConnectorCard from "./cp/ConnectorCard";
import ConfigTab from "./cp/ConfigTab";
import CpTabs from "./cp/CpTabs";
import TransactionsTab from "./cp/TransactionsTab";
import { useCpConfigActions } from "./dashboard/useCpConfigActions";

const StateTransitionViewer = lazy(
  () => import("@/components/state-transition/StateTransitionViewer"),
);

type TabValue = "transactions" | "logs" | "config" | "diagnostics";

/**
 * Builds the `ChargePointConfig` shape `ChargePointConfigModal` expects,
 * from whichever source currently holds this CP's settings — remote mode's
 * `ChargePointSnapshot.config` (daemon-owned, echoed back from the CP's
 * creation params) or local mode's single shared `useConfig()` result
 * (browser-owned, one config for every local CP). Mirrors TopPage.tsx's
 * per-mode prefill derivation (`handleEditChargePoint` / the remote/local
 * branches of its `chargePointConfigs` effect). Kept private (not exported)
 * so this file's only runtime export stays the default component —
 * `ConfigTab` gets the already-built value as a prop instead.
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

const CpDetailPage: React.FC = () => {
  const params = useParams<{ cpId: string }>();
  const cpId = params.cpId ?? "";
  const { mode, chargePointService } = useDataContext();
  const { config: localConfig } = useConfig();
  const { updateCp } = useCpConfigActions();

  const view = useChargePointView(cpId || null);
  const [snapshot, setSnapshot] = useState<ChargePointSnapshot | undefined>();
  const [activeTab, setActiveTab] = useState<TabValue>("transactions");
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isConnectPending, setIsConnectPending] = useState(false);
  const [diagnosticsConnectorOverride, setDiagnosticsConnectorOverride] =
    useState<number | null>(null);

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

  useEffect(() => {
    refreshSnapshot();
  }, [refreshSnapshot]);

  const connectorList = useMemo(
    () => Array.from(view.connectors.values()).sort((a, b) => a.id - b.id),
    [view.connectors],
  );

  const diagnosticsConnectorId =
    diagnosticsConnectorOverride ?? connectorList[0]?.id ?? null;

  // Same proxy for "socket up" that CpCard/ConnectorSidePanel use: after an
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
      setIsEditOpen(false);
      refreshSnapshot();
    } catch (err) {
      console.error(`Failed to save config for ${cpId}`, err);
    }
  };

  // Domain objects (not the snapshot/view-model) — only obtainable in local
  // mode, exactly like `ConnectorSidePanel` derives `localCp`/`connector`.
  // Remote mode has no equivalent (the daemon owns the domain objects), so
  // the Diagnostics tab falls back to an explanatory empty state there.
  const localCp: ChargePoint | null =
    mode === "local" && chargePointService.getLocalChargePoint
      ? ((chargePointService.getLocalChargePoint(cpId) as ChargePoint | null) ??
        null)
      : null;
  const diagnosticsConnector =
    localCp && diagnosticsConnectorId != null
      ? localCp.getConnector(diagnosticsConnectorId)
      : undefined;

  const editInitialConfig = buildChargePointConfig(
    cpId,
    snapshot,
    mode,
    localConfig,
  );

  return (
    <div className="p-6">
      <Link
        to="/"
        className="mb-2 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
      >
        ← Back to charge points
      </Link>

      <PageHeader
        title={<span className="font-mono">{cpId}</span>}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link to={`/scenarios?cp=${encodeURIComponent(cpId)}`}>
                Scenarios
              </Link>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsEditOpen(true)}
            >
              Edit config
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
          </>
        }
      >
        <StatusPill status={isConnected ? view.status : "Disconnected"} />
        {resolvedOcppVersion && (
          <span className="rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
            {resolvedOcppVersion}
            {resolvedSecurityProfile != null
              ? ` · SP${resolvedSecurityProfile}`
              : ""}
          </span>
        )}
      </PageHeader>

      {resolvedWsUrl && (
        <div className="-mt-2 mb-4 font-mono text-xs text-gray-500 dark:text-gray-400">
          {resolvedWsUrl}
        </div>
      )}

      {connectorList.length === 0 ? (
        <EmptyState
          title="No connectors"
          hint="This charge point has no connectors yet."
        />
      ) : (
        <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {connectorList.map((connector) => (
            <ConnectorCard
              key={connector.id}
              cpId={cpId}
              connectorId={connector.id}
            />
          ))}
        </div>
      )}

      <CpTabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as TabValue)}
      >
        <TabsContent value="transactions">
          <TransactionsTab cpId={cpId} />
        </TabsContent>
        <TabsContent value="logs">
          <LogViewer logs={view.logs} onClear={view.clearLogs} />
        </TabsContent>
        <TabsContent value="config">
          <ConfigTab
            config={editInitialConfig}
            mode={mode}
            onEdit={() => setIsEditOpen(true)}
          />
        </TabsContent>
        <TabsContent value="diagnostics">
          {connectorList.length > 1 && (
            <select
              value={diagnosticsConnectorId ?? ""}
              onChange={(e) =>
                setDiagnosticsConnectorOverride(Number(e.target.value))
              }
              className="mb-3 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
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
                  <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
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
        </TabsContent>
      </CpTabs>

      <ChargePointConfigModal
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        onSave={(cpConfig) => void handleSaveConfig(cpConfig)}
        initialConfig={editInitialConfig}
        isNewChargePoint={false}
        mode={mode}
      />
    </div>
  );
};

export default CpDetailPage;
