import React from "react";
import { Play } from "lucide-react";

import { formatEnergyKwh } from "@/lib/connectorFormat";
import { cn } from "@/lib/utils";
import { statusDotClass } from "../../components/statusColor";
import type { LiveRunState } from "../../lib/scenarioRunState";
import type { CpListRow } from "./cpListFilters";

const RUN_STATE_TEXT: Record<LiveRunState, string> = {
  running: "text-blue-600 dark:text-blue-400",
  paused: "text-gray-500 dark:text-gray-400",
  stepping: "text-purple-600 dark:text-purple-400",
  waiting: "text-amber-600 dark:text-amber-400",
};

type RowConnector = CpListRow["connectors"][number];

/** Everything the cell leaves out, for its tooltip. The snapshot carries no
 *  fault code, so a Faulted status shows just the status. */
function connectorTitle(connector: RowConnector): string {
  return [
    connector.status,
    formatEnergyKwh(connector.meterValue),
    connector.transactionId !== null ? `Tx #${connector.transactionId}` : null,
    connector.hasRun && connector.runState
      ? `${connector.runState}: ${connector.runName ?? "scenario"}`
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

export interface ConnectorCellProps {
  cpId: string;
  connector: RowConnector;
  /** The connector open in the side panel. */
  selected: boolean;
  onClick: () => void;
}

/** One connector in the Hierarchy view: little text (number, status, and
 *  either the transaction or the energy), the rest in the tooltip. */
const ConnectorCell: React.FC<ConnectorCellProps> = ({
  cpId,
  connector,
  selected,
  onClick,
}) => (
  <button
    type="button"
    data-connector-cell={`${cpId}#${connector.id}`}
    aria-pressed={selected}
    title={connectorTitle(connector)}
    onClick={onClick}
    className={cn(
      "flex min-w-0 items-center gap-2 rounded-md border border-gray-200 px-2 py-1 text-left text-xs hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800",
      selected &&
        "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/40",
    )}
  >
    <span className="font-mono text-gray-400 dark:text-gray-500">
      #{connector.id}
    </span>
    <span className="flex min-w-0 items-center gap-1.5 text-gray-700 dark:text-gray-200">
      <span
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          statusDotClass(connector.status),
        )}
      />
      <span className="truncate">{connector.status}</span>
    </span>
    {connector.hasRun && (
      <Play
        aria-hidden
        className={cn(
          "h-3 w-3 shrink-0 fill-current",
          RUN_STATE_TEXT[connector.runState ?? "running"],
        )}
      />
    )}
    {connector.transactionId !== null ? (
      <span className="ml-auto shrink-0 font-mono text-gray-500 dark:text-gray-400">
        Tx {connector.transactionId}
      </span>
    ) : (
      connector.meterValue !== 0 && (
        <span className="ml-auto shrink-0 text-gray-500 dark:text-gray-400">
          {formatEnergyKwh(connector.meterValue)}
        </span>
      )
    )}
  </button>
);

export default ConnectorCell;
