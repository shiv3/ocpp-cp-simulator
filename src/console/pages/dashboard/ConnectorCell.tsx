import React from "react";
import { Play } from "lucide-react";

import { formatEnergyKwh } from "@/lib/connectorFormat";
import { cn } from "@/lib/utils";
import { statusDotClass } from "../../components/statusColor";
import type { LiveRunState } from "../../lib/scenarioRunState";
import type { CpListRow } from "./cpListFilters";

const RUN_STATE_TEXT: Record<LiveRunState, string> = {
  running: "text-cx-blue",
  paused: "text-cx-gray",
  stepping: "text-cx-purple",
  waiting: "text-cx-amber",
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
      "flex min-w-0 items-center gap-2 rounded-[7px] bg-cx-sub px-2.5 py-1.5 text-left hover:shadow-[0_0_0_1px_var(--cx-border-strong)]",
      selected &&
        "bg-cx-sel shadow-[0_0_0_1.5px_var(--cx-accent)] hover:shadow-[0_0_0_1.5px_var(--cx-accent)]",
    )}
  >
    <span className="font-mono text-[11.5px] text-cx-faint">
      #{connector.id}
    </span>
    <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-cx-fg2">
      <span
        aria-hidden
        className={cn(
          "h-[7px] w-[7px] shrink-0 rounded-full",
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
      <span className="ml-auto shrink-0 font-mono text-[11.5px] text-cx-muted">
        Tx {connector.transactionId}
      </span>
    ) : (
      connector.meterValue !== 0 && (
        <span className="ml-auto shrink-0 font-mono text-[11.5px] text-cx-muted">
          {formatEnergyKwh(connector.meterValue)}
        </span>
      )
    )}
  </button>
);

export default ConnectorCell;
