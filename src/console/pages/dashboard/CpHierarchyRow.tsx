import React from "react";
import { ChevronRight, PlugZap } from "lucide-react";

import { cn } from "@/lib/utils";
import ActiveScenarioBadge from "../../components/ActiveScenarioBadge";
import NetworkSimBadge from "../../components/network-sim/NetworkSimBadge";
import StatusPill from "../../components/StatusPill";
import { statusDotClass, statusTextClass } from "../../components/statusColor";
import { usePanelParams } from "../../lib/usePanelParams";
import ConnectorCell from "./ConnectorCell";
import type { CpListRow } from "./cpListFilters";
import {
  cpStatus,
  firstWaitingExpectation,
  hasActiveRun,
  lastHeartbeat,
} from "./cpRowFormat";
import CpPowerButton from "./CpPowerButton";

export interface CpHierarchyRowProps {
  row: CpListRow;
  /** The connector grid is folded away (kept by the page, not in the URL). */
  collapsed: boolean;
  onToggleCollapse: () => void;
}

/**
 * One charge point of the Hierarchy view: a head (twist, status icon, id,
 * version, pills, a dot per connector, power button) over a grid of connector
 * cells. The head opens the side panel; so do the cells, on their connector.
 */
const CpHierarchyRow: React.FC<CpHierarchyRowProps> = ({
  row,
  collapsed,
  onToggleCollapse,
}) => {
  const { cp } = row;
  const { open, close, isOpen } = usePanelParams();
  const status = cpStatus(row);
  const selected = isOpen(cp.id);
  const toggleOpen = () => (selected ? close() : open(cp.id));

  // The whole head opens the panel, except where the click already means
  // something else (a button, link or form control inside it handles itself).
  const handleHeadClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest("button, a, input, select, label")) return;
    toggleOpen();
  };

  return (
    <div className="border-t border-gray-200 first:border-t-0 dark:border-gray-800">
      <div
        data-cp-id={cp.id}
        data-selected={selected ? "true" : undefined}
        onClick={handleHeadClick}
        className={cn(
          "flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800/50",
          selected && "bg-blue-50 dark:bg-blue-950/30",
        )}
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} connectors of ${cp.id}`}
          className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 transition-transform",
              !collapsed && "rotate-90",
            )}
          />
        </button>
        <PlugZap className={cn("h-4 w-4 shrink-0", statusTextClass(status))} />
        {/* A button, so the panel opens from the keyboard too. */}
        <button
          type="button"
          onClick={toggleOpen}
          className="font-mono text-sm font-semibold text-gray-900 hover:underline dark:text-gray-100"
        >
          {cp.id}
        </button>
        {row.ocppVersion && (
          <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            {row.ocppVersion}
          </span>
        )}
        <StatusPill status={status} />
        <ActiveScenarioBadge
          isActive={hasActiveRun(row)}
          waitingExpectation={firstWaitingExpectation(row)}
        />
        <NetworkSimBadge summary={cp.networkSim} />
        <span className="flex items-center gap-1">
          {row.connectors.map((connector) => (
            <span
              key={connector.id}
              title={`#${connector.id} ${connector.status}`}
              className={cn(
                "h-2 w-2 rounded-full",
                statusDotClass(connector.status),
              )}
            />
          ))}
        </span>
        <div className="ml-auto">
          <CpPowerButton
            cpId={cp.id}
            connected={row.connected}
            lastHeartbeat={lastHeartbeat(row)}
          />
        </div>
      </div>

      {!collapsed &&
        (row.connectors.length === 0 ? (
          <div className="pb-2 pl-9 pr-3 text-xs text-gray-400 dark:text-gray-500">
            No connectors
          </div>
        ) : (
          <div
            className="grid gap-1.5 pb-2 pl-9 pr-3"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            }}
          >
            {row.connectors.map((connector) => (
              <ConnectorCell
                key={connector.id}
                cpId={cp.id}
                connector={connector}
                selected={isOpen(cp.id, connector.id)}
                onClick={() =>
                  isOpen(cp.id, connector.id)
                    ? close()
                    : open(cp.id, connector.id)
                }
              />
            ))}
          </div>
        ))}
    </div>
  );
};

export default CpHierarchyRow;
