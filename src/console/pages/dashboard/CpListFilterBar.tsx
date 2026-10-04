import React, { useMemo } from "react";

import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import Combobox, { type ComboboxOption } from "../../components/Combobox";
import { FILTER_SELECT_CLASS } from "../../components/filterStyles";
import { statusDotClass } from "../../components/statusColor";
import type { CpListFilters, CpListRow } from "./cpListFilters";
import { cpStatus } from "./cpRowFormat";

export interface CpListFilterBarProps {
  filters: CpListFilters;
  onChange: (patch: Partial<CpListFilters>) => void;
  /** Every row, unfiltered: the options come from the whole list. */
  rows: CpListRow[];
  /** What the filters leave, for the counter. */
  shown: { cps: number; connectors: number };
}

const CHECKBOX_LABEL_CLASS =
  "inline-flex items-center gap-1.5 text-sm text-cx-fg2";

/** `#3` -> `3`: the URL holds the number / id only, whether the operator typed
 *  the `#` or picked a suggestion (which carry it). A lone `#` stays, so the
 *  box can still be typed into. */
const withoutHash = (text: string) => text.replace(/^#(?=\d)/, "");

/** The filter row above the list: three comboboxes, two selects, two checkboxes
 *  and the match counter. The values live in the URL (see `useCpListParams`). */
const CpListFilterBar: React.FC<CpListFilterBarProps> = ({
  filters,
  onChange,
  rows,
  shown,
}) => {
  const cpOptions = useMemo<ComboboxOption[]>(
    () =>
      rows.map((row) => ({
        value: row.cp.id,
        hint: row.ocppVersion,
        dot: statusDotClass(cpStatus(row)),
      })),
    [rows],
  );

  // Every connector number once.
  const connOptions = useMemo<ComboboxOption[]>(() => {
    const numbers = new Set<number>();
    for (const row of rows)
      for (const connector of row.connectors) numbers.add(connector.id);
    return [...numbers].sort((a, b) => a - b).map((n) => ({ value: `#${n}` }));
  }, [rows]);

  // Every running transaction with where it runs.
  const txOptions = useMemo<ComboboxOption[]>(
    () =>
      rows.flatMap((row) =>
        row.connectors.flatMap((connector) =>
          connector.transactionId === null
            ? []
            : [
                {
                  value: `#${connector.transactionId}`,
                  hint: `${row.cp.id} #${connector.id}`,
                },
              ],
        ),
      ),
    [rows],
  );

  const versions = useMemo(() => {
    const found = new Set<string>();
    for (const row of rows) if (row.ocppVersion) found.add(row.ocppVersion);
    // A version from the URL stays selectable even when no charge point has it.
    if (filters.version) found.add(filters.version);
    return [...found].sort();
  }, [rows, filters.version]);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Combobox
        id="cp-filter-q"
        aria-label="Charge point"
        placeholder="Charge point"
        value={filters.q}
        onChange={(q) => onChange({ q })}
        options={cpOptions}
        className="w-44"
      />
      <Combobox
        id="cp-filter-conn"
        aria-label="Connector"
        placeholder="Connector"
        value={filters.conn}
        onChange={(conn) => onChange({ conn: withoutHash(conn) })}
        options={connOptions}
        className="w-32"
      />
      <Combobox
        id="cp-filter-tx"
        aria-label="Transaction"
        placeholder="Transaction"
        value={filters.tx}
        onChange={(tx) => onChange({ tx: withoutHash(tx) })}
        options={txOptions}
        className="w-36"
      />
      <select
        aria-label="Status"
        value={filters.status}
        onChange={(event) =>
          onChange({ status: event.target.value as OCPPStatus | "" })
        }
        className={FILTER_SELECT_CLASS}
      >
        <option value="">Any status</option>
        {Object.values(OCPPStatus).map((status) => (
          <option key={status} value={status}>
            {status}
          </option>
        ))}
      </select>
      <select
        aria-label="OCPP version"
        value={filters.version}
        onChange={(event) => onChange({ version: event.target.value })}
        className={FILTER_SELECT_CLASS}
      >
        <option value="">Any version</option>
        {versions.map((version) => (
          <option key={version} value={version}>
            {version}
          </option>
        ))}
      </select>
      <label className={CHECKBOX_LABEL_CLASS}>
        <input
          type="checkbox"
          checked={filters.connected}
          onChange={(event) => onChange({ connected: event.target.checked })}
        />
        Connected
      </label>
      <label className={CHECKBOX_LABEL_CLASS}>
        <input
          type="checkbox"
          checked={filters.scenario}
          onChange={(event) => onChange({ scenario: event.target.checked })}
        />
        Scenario
      </label>
      <span
        data-testid="cp-list-count"
        className="ml-auto text-xs text-cx-muted"
      >
        {shown.cps} CPs · {shown.connectors} connectors
      </span>
    </div>
  );
};

export default CpListFilterBar;
