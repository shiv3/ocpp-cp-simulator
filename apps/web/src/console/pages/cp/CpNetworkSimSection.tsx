import React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import type {
  ChargePointService,
  ChargePointSnapshot,
} from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import type {
  NetworkSimLayerConfig,
  NetworkSimRule,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";
import EmptyState from "../../components/EmptyState";
import ManualDisconnectButtons from "../../components/network-sim/ManualDisconnectButtons";
import { NetworkSimEditor } from "../../components/network-sim/NetworkSimEditor";

export interface CpNetworkSimSectionProps {
  cpId: string;
  chargePointService: ChargePointService;
  snapshot: ChargePointSnapshot | undefined;
  isConnected: boolean;
  networkSimLoadError: string | null;
  networkSimGlobalConfig: NetworkSimLayerConfig | null | undefined;
  networkSimCpConfig: NetworkSimLayerConfig | null | undefined;
  inheritedNetworkSimRules: Record<string, NetworkSimRule>;
  refreshNetworkSim: () => void;
}

/** The Network simulation tab of the charge point's lower half. */
export const CpNetworkSimSection: React.FC<CpNetworkSimSectionProps> = ({
  cpId,
  chargePointService,
  snapshot,
  isConnected,
  networkSimLoadError,
  networkSimGlobalConfig,
  networkSimCpConfig,
  inheritedNetworkSimRules,
  refreshNetworkSim,
}) => {
  const { t } = useTranslation();
  return (
    <section>
      <div className="rounded-[10px] border border-cx-border bg-cx-card p-4 shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none">
        {networkSimLoadError && (
          <div className="mb-4 rounded-md border border-cx-rose bg-cx-rose/10 p-3 text-sm text-cx-rose">
            {networkSimLoadError}
          </div>
        )}
        {networkSimGlobalConfig === undefined && !networkSimLoadError && (
          <p className="text-sm text-cx-muted">
            {t("cp.page.loadingNetworkSim")}
          </p>
        )}
        {networkSimGlobalConfig === null && !networkSimLoadError && (
          // No global layer saved: this charge point's settings are an
          // override of it, so there is nothing to edit yet.
          <EmptyState
            title={t("cp.page.networkSimNotSetUp")}
            hint={t("cp.page.networkSimNotSetUpHint")}
            action={
              <Link
                to="/settings#network-simulation"
                className="text-sm text-cx-accent hover:underline"
              >
                {t("cp.page.openNetworkSettings")}
              </Link>
            }
          />
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
                    {t("cp.page.manualRules")}
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
  );
};
