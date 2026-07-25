import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Settings from "../../components/Settings";
import { useDataContext } from "../../data/providers/DataProvider";
import { NetworkSimEditor } from "../components/network-sim/NetworkSimEditor";
import type { NetworkSimLayerConfig } from "../../cp/infrastructure/transport/network-sim/config";

const SettingsPage: React.FC = () => {
  const { chargePointService } = useDataContext();
  const [networkSimConfig, setNetworkSimConfig] =
    useState<NetworkSimLayerConfig | null>(null);
  const [isLoadingNetSim, setIsLoadingNetSim] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingNetSim(true);
    void chargePointService.getNetworkSimGlobal().then((config) => {
      if (!cancelled) {
        setNetworkSimConfig(config);
        setIsLoadingNetSim(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chargePointService]);

  const handleSaveNetworkSim = async (config: NetworkSimLayerConfig | null) => {
    await chargePointService.saveNetworkSimGlobal(config);
    setNetworkSimConfig(config);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-end">
        <Link
          to="/"
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          Open classic UI
        </Link>
      </div>
      <Settings />

      {!isLoadingNetSim && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
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
  );
};

export default SettingsPage;
