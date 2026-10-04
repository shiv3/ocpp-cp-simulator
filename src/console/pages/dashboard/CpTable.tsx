import React from "react";

import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import ActiveScenarioBadge from "../../components/ActiveScenarioBadge";
import StatusPill from "../../components/StatusPill";
import { formatRelativeTime } from "../../lib/formatRelativeTime";
import { usePanelParams } from "../../lib/usePanelParams";
import type { CpListRow } from "./cpListFilters";
import {
  cpStatus,
  firstWaitingExpectation,
  hasActiveRun,
  inUseCount,
  lastHeartbeat,
} from "./cpRowFormat";

/** The Charge points view: one table row per charge point. */
const CpTable: React.FC<{ rows: CpListRow[] }> = ({ rows }) => {
  const { open, close, isOpen } = usePanelParams();

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Charge point</TableHead>
          <TableHead>OCPP</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">In use</TableHead>
          <TableHead>Scenario</TableHead>
          <TableHead>Heartbeat</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const { cp } = row;
          const selected = isOpen(cp.id);
          const toggleOpen = () => (selected ? close() : open(cp.id));
          const { busy, total } = inUseCount(row);
          return (
            <TableRow
              key={cp.id}
              data-cp-id={cp.id}
              data-selected={selected ? "true" : undefined}
              onClick={(event) => {
                // A button inside the row handles its own click.
                if ((event.target as Element).closest("button, a")) return;
                toggleOpen();
              }}
              className={cn("cursor-pointer", selected && "bg-cx-sel")}
            >
              <TableCell>
                {/* A button, so the panel opens from the keyboard too. */}
                <button
                  type="button"
                  onClick={toggleOpen}
                  className="font-mono text-sm font-semibold text-cx-fg hover:underline"
                >
                  {cp.id}
                </button>
              </TableCell>
              <TableCell className="font-mono text-[11.5px] text-cx-faint">
                {row.ocppVersion ?? "—"}
              </TableCell>
              <TableCell>
                <StatusPill status={cpStatus(row)} />
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {busy} / {total}
              </TableCell>
              <TableCell>
                {hasActiveRun(row) ? (
                  <ActiveScenarioBadge
                    isActive
                    waitingExpectation={firstWaitingExpectation(row)}
                  />
                ) : (
                  <span className="text-cx-faint">—</span>
                )}
              </TableCell>
              <TableCell className="text-xs text-cx-muted">
                {formatRelativeTime(lastHeartbeat(row))}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};

export default CpTable;
