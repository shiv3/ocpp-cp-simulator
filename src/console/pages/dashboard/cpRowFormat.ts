import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { StatusPillStatus } from "../../components/statusColor";
import type { CpListRow } from "./cpListFilters";

/** Connectors that count as "in use" in the Charge points view: a vehicle is
 *  plugged in or a transaction is running. */
const BUSY_STATUSES: ReadonlySet<OCPPStatus> = new Set([
  OCPPStatus.Charging,
  OCPPStatus.Preparing,
  OCPPStatus.SuspendedEV,
  OCPPStatus.SuspendedEVSE,
  OCPPStatus.Finishing,
]);

/** What the status pill of a charge point shows: a charge point whose
 *  transport is down reads Disconnected, not its last OCPP status. */
export function cpStatus(row: CpListRow): StatusPillStatus {
  return row.connected ? row.cp.status : "Disconnected";
}

/** `busy / total` of the "In use" column, over the connectors the row holds
 *  (so under a connector-level filter, over the matching ones). */
export function inUseCount(row: CpListRow): { busy: number; total: number } {
  return {
    busy: row.connectors.filter((c) => BUSY_STATUSES.has(c.status)).length,
    total: row.connectors.length,
  };
}

export function hasActiveRun(row: CpListRow): boolean {
  return row.connectors.some((c) => c.hasRun);
}

/** What the first parked run waits for: it turns the badge amber. */
export function firstWaitingExpectation(row: CpListRow): string | undefined {
  return row.connectors.find((c) => c.waitingExpectation)?.waitingExpectation;
}

/** Wall-clock time of the last Heartbeat.req, null before the first. */
export function lastHeartbeat(row: CpListRow): Date | null {
  const sentAt = row.cp.heartbeat?.lastSentAt;
  return sentAt ? new Date(sentAt) : null;
}
