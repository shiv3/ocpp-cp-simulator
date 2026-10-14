import React, { useCallback, useMemo, useState } from "react";

import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";
import type { CpListRow } from "./cpListFilters";
import CpRowReporter from "./CpRowReporter";

interface ReportedRow {
  /** Stable JSON of the row, to tell a real change from a new identity. */
  key: string;
  row: CpListRow;
}

/**
 * The live row of every charge point, collected in one place so the page can
 * filter and count across all of them.
 *
 * A charge point's live data comes from hooks (`useChargePointView`,
 * `useActiveScenarioRuns`), and hooks cannot run in a loop. So the page
 * renders one `CpRowReporter` per charge point (`reporters`, to be placed
 * anywhere in the tree; they render nothing) and each reports its row upward
 * from an effect into one state map keyed by id. A report whose content did
 * not change is dropped (the hooks hand out new objects on every event, the
 * content rarely changes), which is what keeps this from re-rendering the
 * page in a loop.
 *
 * `rows` follows the order of `chargePoints` and omits a charge point whose
 * reporter has not run yet; `complete` is true once every one has reported
 * (the page waits for it before saying "no match").
 */
export function useCpListRows(
  chargePoints: ChargePointSnapshot[],
  ocppVersionFallback?: string,
): { rows: CpListRow[]; reporters: React.ReactNode; complete: boolean } {
  const [reported, setReported] = useState<Record<string, ReportedRow>>({});

  const report = useCallback((row: CpListRow) => {
    // The live connectors are in `row.connectors`; leave the copy in `cp` out
    // of the key so a change is not compared twice.
    const key = JSON.stringify({ ...row, cp: { ...row.cp, connectors: [] } });
    setReported((prev) =>
      prev[row.cp.id]?.key === key
        ? prev
        : { ...prev, [row.cp.id]: { key, row } },
    );
  }, []);

  const forget = useCallback((id: string) => {
    setReported((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const rows = useMemo(
    () =>
      chargePoints.flatMap((cp) =>
        reported[cp.id] ? [reported[cp.id].row] : [],
      ),
    [chargePoints, reported],
  );

  const reporters = chargePoints.map((cp) => (
    <CpRowReporter
      key={cp.id}
      cp={cp}
      ocppVersionFallback={ocppVersionFallback}
      report={report}
      forget={forget}
    />
  ));

  return { rows, reporters, complete: rows.length === chargePoints.length };
}
