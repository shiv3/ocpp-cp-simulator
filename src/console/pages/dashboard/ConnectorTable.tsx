import React from "react";

import { formatEnergyKwh } from "@/lib/connectorFormat";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import StatusPill from "../../components/StatusPill";
import { LIVE_RUN_STATE_STYLES } from "../../lib/scenarioRunState";
import { usePanelParams } from "../../lib/usePanelParams";
import type { CpListRow } from "./cpListFilters";
import { cpStatus } from "./cpRowFormat";

/** The Connectors view: one flat table row per connector of every charge
 *  point shown. A row opens the side panel on that connector. */
const ConnectorTable: React.FC<{ rows: CpListRow[] }> = ({ rows }) => {
  const { open, close, isOpen } = usePanelParams();

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Connector</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Meter</TableHead>
          <TableHead>Tx</TableHead>
          <TableHead>Scenario</TableHead>
          <TableHead>Charge point</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.flatMap((row) =>
          row.connectors.map((connector) => {
            const selected = isOpen(row.cp.id, connector.id);
            return (
              <TableRow
                key={`${row.cp.id}#${connector.id}`}
                data-cp-id={row.cp.id}
                data-connector-id={connector.id}
                data-selected={selected ? "true" : undefined}
                onClick={() =>
                  selected ? close() : open(row.cp.id, connector.id)
                }
                className={cn(
                  "cursor-pointer",
                  selected && "bg-blue-50 dark:bg-blue-950/30",
                )}
              >
                <TableCell className="font-mono text-sm">
                  {/* A button, so the panel opens from the keyboard too. */}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (selected) close();
                      else open(row.cp.id, connector.id);
                    }}
                    className="font-semibold text-gray-900 hover:underline dark:text-gray-100"
                  >
                    {row.cp.id} #{connector.id}
                  </button>
                </TableCell>
                <TableCell>
                  {/* The snapshot has no fault code to show beside Faulted. */}
                  <StatusPill status={connector.status} />
                </TableCell>
                <TableCell className="text-right text-xs">
                  {formatEnergyKwh(connector.meterValue)}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {connector.transactionId !== null ? (
                    `#${connector.transactionId}`
                  ) : (
                    <span className="text-gray-400 dark:text-gray-500">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {connector.hasRun && connector.runState ? (
                    <span
                      title={connector.runName}
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-semibold",
                        LIVE_RUN_STATE_STYLES[connector.runState],
                      )}
                    >
                      {connector.runState}
                    </span>
                  ) : (
                    <span className="text-gray-400 dark:text-gray-500">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <StatusPill status={cpStatus(row)} />
                </TableCell>
              </TableRow>
            );
          }),
        )}
      </TableBody>
    </Table>
  );
};

export default ConnectorTable;
