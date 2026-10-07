import React, { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import Settings from "../../components/Settings";
import { useDataContext } from "../../data/providers/DataProvider";
import { NetworkSimEditor } from "../components/network-sim/NetworkSimEditor";
import type { NetworkSimLayerConfig } from "../../cp/infrastructure/transport/network-sim/config";

const SettingsPage: React.FC = () => {
  const { chargePointService } = useDataContext();
  const { hash } = useLocation();
  const [networkSimConfig, setNetworkSimConfig] =
    useState<NetworkSimLayerConfig | null>(null);
  const [isLoadingNetSim, setIsLoadingNetSim] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingNetSim(true);
    setLoadError(null);
    void chargePointService
      .getNetworkSimGlobal()
      .then((config) => {
        if (!cancelled) {
          setNetworkSimConfig(config);
          setIsLoadingNetSim(false);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Failed to load network simulation configuration",
          );
          setIsLoadingNetSim(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chargePointService]);

  // `/settings#network-simulation` (the charge point's Network simulation tab
  // links here) scrolls the section into view once it has rendered.
  const networkSimShown = !isLoadingNetSim && !loadError;
  useEffect(() => {
    if (hash !== "#network-simulation" || !networkSimShown) return;
    document.getElementById("network-simulation")?.scrollIntoView?.();
  }, [hash, networkSimShown]);

  const handleSaveNetworkSim = async (config: NetworkSimLayerConfig | null) => {
    await chargePointService.saveNetworkSimGlobal(config);
    setNetworkSimConfig(config);
  };

  return (
    <div className="p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <Settings />

        {!isLoadingNetSim && loadError && (
          <div className="rounded-md border border-cx-rose bg-cx-rose/10 p-3 text-sm text-cx-rose">
            {loadError}
          </div>
        )}

        {!isLoadingNetSim && !loadError && (
          <div
            id="network-simulation"
            className="rounded-[10px] border border-cx-border bg-cx-card shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none p-6"
          >
            <h2 className="mb-4 text-lg font-semibold text-cx-fg">
              Network Simulation
            </h2>
            <NetworkSimEditor
              value={networkSimConfig}
              onSave={handleSaveNetworkSim}
              mode="global"
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsPage;
