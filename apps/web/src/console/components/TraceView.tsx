import "@open-ocpp-trace/viewer-react/styles.css";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createCorrelator,
  createViewerStore,
  type TraceFilter,
} from "@open-ocpp-trace/viewer-core";
import {
  TraceViewer,
  type ExportScope,
  type JsonlExport,
  type ViewerTheme,
} from "@open-ocpp-trace/viewer-react";

import { useDarkMode } from "../../contexts/DarkModeContext";
import { downloadText } from "../../utils/downloadJson";
import type { GlobalLogEntry } from "../lib/globalLogsContext";
import { createTraceFeed } from "../lib/traceFeed";
import { createViewerTranslate } from "../lib/traceViewerTranslate";

export interface TraceViewProps {
  /** The log ring buffer, newest first (`useGlobalLogs().entries`). */
  entries: readonly GlobalLogEntry[];
  /** The charge point filter, shared with the log view (`?cp=`). */
  selectedCpIds: readonly string[];
  onCpFilterChange: (ids: string[]) => void;
}

/** The console's `cx-*` colors, which follow its dark mode on their own. */
const TOKENS: ViewerTheme["tokens"] = {
  background: "var(--cx-card)",
  color: "var(--cx-fg)",
  borderColor: "var(--cx-border)",
  headerBackground: "var(--cx-sub)",
  selectedBackground: "var(--cx-sel)",
  selectedColor: "var(--cx-fg)",
  focusColor: "var(--cx-accent)",
};

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * The Message Log's trace view: the OCPP-J frames of the log buffer as Open
 * OCPP Trace records, in `@open-ocpp-trace/viewer-react`. One store per
 * mount, fed only with the lines it has not seen (see `createTraceFeed`);
 * the correlator pairs responses per charge point, since two charge points
 * may receive CSMS CALLs with the same message id.
 */
const TraceView: React.FC<TraceViewProps> = ({
  entries,
  selectedCpIds,
  onCpFilterChange,
}) => {
  const { t } = useTranslation();
  const { isDark } = useDarkMode();

  // Created once: the store and the feed's position must survive renders.
  // The correlator is never disconnected: it lives as long as the store.
  const [{ store, correlator, feed }] = useState(() => {
    const store = createViewerStore();
    const correlator = createCorrelator({ scope: "chargePoint" });
    correlator.connect(store);
    const feed = createTraceFeed({
      push: (added) =>
        store.apply(added.map((entry) => ({ type: "add", entry }))),
    });
    return { store, correlator, feed };
  });

  useEffect(() => {
    feed.ingest(entries);
  }, [feed, entries]);

  // The charge point group is the page's `?cp=` filter; the rest of the
  // filter is this view's own.
  const [ownFilter, setOwnFilter] = useState<TraceFilter>({});
  const filter = useMemo<TraceFilter>(
    () =>
      selectedCpIds.length > 0
        ? { ...ownFilter, chargePointIds: selectedCpIds }
        : ownFilter,
    [ownFilter, selectedCpIds],
  );
  const handleFilterChange = useCallback(
    (next: TraceFilter) => {
      const { chargePointIds, ...rest } = next;
      setOwnFilter(rest);
      const ids = (chargePointIds ?? []).filter(
        (id): id is string => id !== null,
      );
      if (!sameIds(ids, selectedCpIds)) onCpFilterChange(ids);
    },
    [selectedCpIds, onCpFilterChange],
  );

  const theme = useMemo<ViewerTheme>(
    () => ({ colorScheme: isDark ? "dark" : "light", tokens: TOKENS }),
    [isDark],
  );
  const translate = useMemo(() => createViewerTranslate(t), [t]);

  const handleExport = useCallback(
    (exported: JsonlExport, scope: ExportScope) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadText(
        exported.text,
        `ocpp-trace-${scope}-${stamp}.jsonl`,
        "application/x-ndjson",
      );
    },
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="text-[12px] text-cx-muted">
        {t("dashboard.logs.trace.note")}
      </p>
      <div className="min-h-0 flex-1">
        <TraceViewer
          store={store}
          correlator={correlator}
          filter={filter}
          onFilterChange={handleFilterChange}
          onExport={handleExport}
          theme={theme}
          translate={translate}
          className="h-full"
        />
      </div>
    </div>
  );
};

export default TraceView;
