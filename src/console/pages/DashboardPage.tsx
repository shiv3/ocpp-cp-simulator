import React, { useState } from "react";
import { Link } from "react-router-dom";
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
import { formatLogTime, useGlobalLogs } from "../lib/useGlobalLogs";
import CpCard from "./dashboard/CpCard";
import { useCpConfigActions } from "./dashboard/useCpConfigActions";

const RECENT_ACTIVITY_LIMIT = 5;

const DashboardPage: React.FC = () => {
  const { mode } = useDataContext();
  const { config, isLoading } = useConfig();
  const { chargePoints } = useChargePoints(config, { isLoading });
  const { addCp } = useCpConfigActions();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const { entries: logEntries } = useGlobalLogs();
  const recentActivity = logEntries.slice(0, RECENT_ACTIVITY_LIMIT);

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

      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
            Recent activity
          </h2>
          <Link
            to="/logs"
            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Open Message Log →
          </Link>
        </div>
        {recentActivity.length === 0 ? (
          <p className="text-xs text-gray-400 dark:text-gray-500">
            No activity yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {recentActivity.map((item) => (
              <li
                key={item.seq}
                className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300"
              >
                <span className="font-mono text-gray-400 dark:text-gray-500">
                  {formatLogTime(item.entry.timestamp)}
                </span>
                <span className="font-mono font-medium text-gray-700 dark:text-gray-200">
                  {item.cpId}
                </span>
                <span className="truncate">{item.entry.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

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
