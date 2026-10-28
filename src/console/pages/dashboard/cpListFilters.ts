import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type {
  ChargePointSnapshot,
  ConnectorSnapshot,
} from "../../../data/interfaces/ChargePointService";
import type { LiveRunState } from "../../lib/scenarioRunState";
import { matchesLabelSelector } from "../../../protocol/labels";

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
  /** A connector number, `3` or `#3` (`?conn=`: `?connector=` is the side
   *  panel's own key on this page). */
  conn: string;
  /** A transaction id, or part of one: `42` or `#42` (`?tx=`). */
  tx: string;
  /** A connector status, or "" for any. */
  status: OCPPStatus | "";
  /** An OCPP version, or "" for any. */
  version: string;
  /** Label selector as typed (`?label=`, #446): comma-separated `key=value`
   *  pairs, all of which must match; a bare `key` asks for the key only. */
  label: string;
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
    tx: params.get("tx") ?? "",
    status: Object.values(OCPPStatus).find((value) => value === status) ?? "",
    version: params.get("version") ?? "",
    label: params.get("label") ?? "",
    connected: params.get("connected") === "1",
    scenario: params.get("scenario") === "1",
  };
}

/** `#3` or `3`: an optional `#` and digits. Returns the digits, "" when
 *  nothing but the prefix was typed (no constraint yet, so the list does not
 *  blank while the operator is still typing) and null when the text is not in
 *  that form (matches nothing). */
function parseDigits(text: string): string | null {
  const match = /^#?\s*(\d*)$/.exec(text.trim());
  return match ? match[1] : null;
}

/**
 * The label filter as typed: comma-separated items, each split on its first
 * `=` (so a value may hold one) into an exact pair, or kept as a bare key that
 * asks for the key only. Blank items are dropped, which keeps the list whole
 * while a `,` is typed.
 */
function parseLabelFilter(text: string): {
  selector: Record<string, string>;
  keys: string[];
  /** One key asked with two different values: nothing can match both. */
  contradictory: boolean;
} {
  const selector: Record<string, string> = {};
  const keys: string[] = [];
  let contradictory = false;
  for (const item of text.split(",").map((part) => part.trim())) {
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq === -1) {
      keys.push(item);
      continue;
    }
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (Object.hasOwn(selector, key) && selector[key] !== value)
      contradictory = true;
    selector[key] = value;
  }
  return { selector, keys, contradictory };
}

/**
 * The filter text for one label, or null when the syntax above cannot say it
 * (a comma, or blanks it would trim): a suggestion built from such a pair
 * would match nothing, its own charge point included.
 */
export function formatLabelTerm(key: string, value: string): string | null {
  if (value.includes(",") || value !== value.trim()) return null;
  return `${key}=${value}`;
}

/**
 * Applies the filters to the list. Charge-point-level filters (q, version,
 * label, connected) drop whole rows. Connector-level filters (conn, tx, status,
 * scenario)
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
  const label = parseLabelFilter(filters.label);
  const conn = parseDigits(filters.conn);
  const tx = parseDigits(filters.tx);
  const connectorLevel =
    conn !== "" || tx !== "" || filters.status !== "" || filters.scenario;

  const result: CpListRow[] = [];
  for (const row of rows) {
    if (q && !row.cp.id.toLowerCase().includes(q)) continue;
    if (filters.version && row.ocppVersion !== filters.version) continue;
    // Exact pairs through the daemon's own `cp.list` matcher; the bare-key
    // form is the console's addition.
    const labels = row.cp.config?.labels;
    if (label.contradictory) continue;
    if (!matchesLabelSelector(labels, label.selector)) continue;
    if (!label.keys.every((key) => labels && Object.hasOwn(labels, key)))
      continue;
    if (filters.connected && !row.connected) continue;
    if (!connectorLevel) {
      result.push(row);
      continue;
    }
    const connectors = row.connectors.filter(
      (c) =>
        // null: text that is no connector number / transaction id.
        conn !== null &&
        tx !== null &&
        (conn === "" || c.id === Number(conn)) &&
        // The id is a number, so "contains" is a match on its digits.
        (tx === "" ||
          (c.transactionId !== null && String(c.transactionId).includes(tx))) &&
        (filters.status === "" || c.status === filters.status) &&
        (!filters.scenario || c.hasRun),
    );
    if (connectors.length > 0) result.push({ ...row, connectors });
  }
  return result;
}
