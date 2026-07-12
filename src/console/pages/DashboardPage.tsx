import React, { useState } from "react";
import { Plus, PlugZap } from "lucide-react";

import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import ChargePointConfigModal, {
  defaultChargePointConfig,
} from "../../components/ChargePointConfigModal";
import { useChargePoints } from "../../data/hooks/useChargePoints";
import { useConfig } from "../../data/hooks/useConfig";
import { useDataContext } from "../../data/providers/DataProvider";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import CpCard from "./dashboard/CpCard";
import { useCpConfigActions } from "./dashboard/useCpConfigActions";

const DashboardPage: React.FC = () => {
  const { mode } = useDataContext();
  const { config, isLoading } = useConfig();
  const { chargePoints } = useChargePoints(config, { isLoading });
  const { addCp } = useCpConfigActions();
  const [isAddOpen, setIsAddOpen] = useState(false);

  const connectedCount = chargePoints.filter(
    (cp) => cp.status !== OCPPStatus.Unavailable,
  ).length;

  const addButton = (
    <button
      type="button"
      onClick={() => setIsAddOpen(true)}
      className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
    >
      <Plus className="h-4 w-4" />
      Add Charge Point
    </button>
  );

  return (
    <div className="p-6">
      <PageHeader
        title="Charge Points"
        count={`${chargePoints.length} registered · ${connectedCount} connected`}
        actions={addButton}
      />

      {chargePoints.length === 0 ? (
        <EmptyState
          icon={PlugZap}
          title="No charge points"
          hint="Add a charge point to start simulating OCPP traffic."
          action={addButton}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {chargePoints.map((cp) => (
            <CpCard
              key={cp.id}
              cp={cp}
              // Local-mode snapshots don't carry `config` (the browser owns
              // config, not the service) — fall back to the shared local
              // config's ocppVersion so the chip still shows in local mode.
              ocppVersion={mode === "local" ? config?.ocppVersion : undefined}
            />
          ))}
        </div>
      )}

      <ChargePointConfigModal
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onSave={(cpConfig) => void addCp(cpConfig)}
        mode={mode}
        initialConfig={defaultChargePointConfig}
        isNewChargePoint
      />
    </div>
  );
};

export default DashboardPage;
