import "@open-ocpp-trace/viewer-react/styles.css";
import "./TraceView.css";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  type ToolbarAction,
  type ViewerTheme,
} from "@open-ocpp-trace/viewer-react";

import { useDarkMode } from "../../contexts/DarkModeContext";
import { downloadText } from "../../utils/downloadJson";
import { JsonHighlight } from "./JsonHighlight";
import type { GlobalLogEntry } from "../lib/globalLogsContext";
import { createTraceFeed } from "../lib/traceFeed";
import { createViewerTranslate } from "../lib/traceViewerTranslate";

export interface TraceViewProps {
  /** The log ring buffer, newest first (`useGlobalLogs().entries`). */
  entries: readonly GlobalLogEntry[];
  /** The charge point filter, shared with the log view (`?cp=`). */
  selectedCpIds: readonly string[];
  onCpFilterChange: (ids: string[]) => void;
  /** The OcppVersion constant of each charge point (e.g. "OCPP-1.6J"); a
   *  frame of a charge point missing here has no OCPP version. */
  ocppVersions: ReadonlyMap<string, string>;
}

/** The console's `cx-*` colors, which follow its dark mode on their own, and
 *  its sans font (TraceView.css sets the controls and the mono data). */
const TOKENS: ViewerTheme["tokens"] = {
  background: "var(--cx-card)",
  color: "var(--cx-fg)",
  borderColor: "var(--cx-border)",
  headerBackground: "var(--cx-sub)",
  selectedBackground: "var(--cx-sel)",
  selectedColor: "var(--cx-fg)",
  focusColor: "var(--cx-accent)",
  fontFamily: "var(--font-sans)",
};

const DETAILS_HIDDEN_KEY = "ocpp-cp.console.trace.detailsHidden";

function readStoredDetailsHidden(): boolean {
  try {
    return window.localStorage.getItem(DETAILS_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function storeDetailsHidden(hidden: boolean): void {
  try {
    if (hidden) {
      window.localStorage.setItem(DETAILS_HIDDEN_KEY, "1");
    } else {
      window.localStorage.removeItem(DETAILS_HIDDEN_KEY);
    }
  } catch {
    // storage unavailable (private window): the state just isn't kept
  }
}

const renderPayload = (text: string) => <JsonHighlight text={text} />;

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
  ocppVersions,
}) => {
  const { t } = useTranslation();
  const { isDark } = useDarkMode();

  // Read at ingest time: the feed is created once, the versions change.
  const ocppVersionsRef = useRef(ocppVersions);
  ocppVersionsRef.current = ocppVersions;

  // Created once: the store and the feed's position must survive renders.
  // The correlator is never disconnected: it lives as long as the store.
  const [{ store, correlator, feed }] = useState(() => {
    const store = createViewerStore();
    const correlator = createCorrelator({ scope: "chargePoint" });
    correlator.connect(store);
    const feed = createTraceFeed({
      push: (added) =>
        store.apply(added.map((entry) => ({ type: "add", entry }))),
      ocppVersionOf: (cpId) => ocppVersionsRef.current.get(cpId),
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

  // The detail panel folds away from the toolbar, to give the list the width.
  const [detailsHidden, setDetailsHidden] = useState(readStoredDetailsHidden);
  const toolbarActions = useMemo<ToolbarAction[]>(
    () => [
      {
        id: "toggle-details",
        label: detailsHidden
          ? t("dashboard.logs.trace.showDetails")
          : t("dashboard.logs.trace.hideDetails"),
        run: () => {
          storeDetailsHidden(!detailsHidden);
          setDetailsHidden(!detailsHidden);
        },
      },
    ],
    [detailsHidden, t],
  );

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
      <div
        className={`cx-trace min-h-0 flex-1${detailsHidden ? " cx-trace--no-details" : ""}`}
      >
        <TraceViewer
          store={store}
          correlator={correlator}
          filter={filter}
          onFilterChange={handleFilterChange}
          onExport={handleExport}
          renderPayload={renderPayload}
          toolbarActions={toolbarActions}
          theme={theme}
          translate={translate}
          className="h-full"
        />
      </div>
    </div>
  );
};

export default TraceView;
