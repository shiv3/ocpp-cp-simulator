import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type {
  ChargePointSnapshot,
  ConnectorSnapshot,
} from "../../../data/interfaces/ChargePointService";
import type { LiveRunState } from "../../lib/scenarioRunState";

/** One charge point of the list with everything the three views and the
 *  filters read: the live snapshot (status, heartbeat, connectors) plus what
 *  the page derives from the hooks. Built per charge point by `useCpListRows`. */
export interface CpListRow {
  /** The list's snapshot with the live status, heartbeat and connectors. */
  cp: ChargePointSnapshot;
  /** `cp.config.ocppVersion`, or in Local mode the shared config's. */
  ocppVersion?: string;
  /** `connected || status !== Unavailable` (see `useCpListRows`). */
  connected: boolean;
  connectors: Array<
    ConnectorSnapshot & {
      /** A scenario run is active on this connector. */
      hasRun: boolean;
      runState?: LiveRunState;
      /** Name of the scenario that is running. */
      runName?: string;
      /** What the run is parked on, when it is waiting. */
      waitingExpectation?: string;
    }
  >;
}

export interface CpListFilters {
  /** Substring of the charge point id (case-insensitive). */
  q: string;
  /** `#3`, `3`, `Tx 42`, `tx42` or `42`: see `matchesConnectorQuery`. */
  conn: string;
  /** A connector status, or "" for any. */
  status: OCPPStatus | "";
  /** An OCPP version, or "" for any. */
  version: string;
  connected: boolean;
  /** Only connectors with an active scenario run. */
  scenario: boolean;
}

export type CpListView = "hierarchy" | "cp" | "connectors";

const VIEWS: readonly CpListView[] = ["hierarchy", "cp", "connectors"];

/** `?view=`; the hierarchy is the default and is left out of the URL. */
export function parseCpListView(params: URLSearchParams): CpListView {
  const view = params.get("view");
  return VIEWS.find((v) => v === view) ?? "hierarchy";
}

/** Reads the list's filters from the URL's search params. Unknown statuses
 *  and flags other than `1` count as "not set", so a hand-edited URL never
 *  hides every charge point behind a value the controls cannot show. */
export function parseCpListFilters(params: URLSearchParams): CpListFilters {
  const status = params.get("status");
  return {
    // Not trimmed: the boxes show these as typed, and a trailing space must
    // survive the round trip through the URL. The filter trims.
    q: params.get("q") ?? "",
    conn: params.get("conn") ?? "",
    status: Object.values(OCPPStatus).find((value) => value === status) ?? "",
    version: params.get("version") ?? "",
    connected: params.get("connected") === "1",
    scenario: params.get("scenario") === "1",
  };
}

/** `#3`, `3`, `Tx 42`, `tx42`, `42`: an optional `#` / `Tx` prefix and digits.
 *  Returns the digits, "" when only a prefix was typed (no constraint yet, so
 *  the list does not blank while the operator is still typing) and null when
 *  the text is not in that form (matches nothing). */
function parseConnectorQuery(conn: string): string | null {
  const match = /^(?:#|tx)?\s*(\d*)$/i.exec(conn.trim());
  return match ? match[1] : null;
}

/** The number equals the connector's, or the transaction id contains it, so
 *  one box finds both "connector 2" and "transaction 42". */
function matchesConnectorQuery(
  connector: ConnectorSnapshot,
  digits: string,
): boolean {
  if (digits === "") return true;
  if (connector.id === Number(digits)) return true;
  return (
    connector.transactionId !== null &&
    String(connector.transactionId).includes(digits)
  );
}

/**
 * Applies the filters to the list. Charge-point-level filters (q, version,
 * connected) drop whole rows. Connector-level filters (conn, status, scenario)
 * narrow each row's connectors to the matching ones and drop the rows left
 * with none, so a status filter hides the charge points without a connector in
 * that status and the Hierarchy view hides the other connector cells. Rows are
 * returned as given when no connector-level filter is set (a charge point
 * without connectors stays listed). Does not mutate its input.
 */
export function filterChargePoints(
  rows: CpListRow[],
  filters: CpListFilters,
): CpListRow[] {
  const q = filters.q.trim().toLowerCase();
  const digits = parseConnectorQuery(filters.conn);
  const connectorLevel =
    digits !== "" || filters.status !== "" || filters.scenario;

  const result: CpListRow[] = [];
  for (const row of rows) {
    if (q && !row.cp.id.toLowerCase().includes(q)) continue;
    if (filters.version && row.ocppVersion !== filters.version) continue;
    if (filters.connected && !row.connected) continue;
    if (!connectorLevel) {
      result.push(row);
      continue;
    }
    const connectors = row.connectors.filter(
      (c) =>
        // null: text that is no connector / transaction reference.
        digits !== null &&
        matchesConnectorQuery(c, digits) &&
        (filters.status === "" || c.status === filters.status) &&
        (!filters.scenario || c.hasRun),
    );
    if (connectors.length > 0) result.push({ ...row, connectors });
  }
  return result;
}
