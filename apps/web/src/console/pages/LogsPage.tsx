import { useTranslation } from "react-i18next";
import React, { Suspense, lazy, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { t as translate } from "../../i18n";
import {
  LogViewer,
  type ClearLogsScope,
  type ViewerLogEntry,
} from "@/components/ui/log-viewer";
import { useChargePoints } from "../../data/hooks/useChargePoints";
import { useConfig } from "../../data/hooks/useConfig";
import { useDataContext } from "../../data/providers/DataProvider";
import { downloadStoredLogs } from "../../lib/downloadStoredLogs";
import PageHeader from "../components/PageHeader";
import { useGlobalLogs, type GlobalLogEntry } from "../lib/useGlobalLogs";

// The trace viewer is its own chunk, fetched when the Trace tab opens.
const TraceView = lazy(() => import("../components/TraceView"));

type LogsView = "log" | "trace";

/**
 * Global, cross-charge-point Message Log. Aggregates every CP's
 * `{type: "log"}` events via `useGlobalLogs` — there's no server-side
 * aggregate endpoint, so this is purely a client-side merge of per-CP
 * subscriptions (see that hook's doc comment). The page is the `LogViewer`
 * (filter sidebar with counts, toolbar, search, table) filling the window
 * under a header that keeps **Pause / Resume**, which is about the buffer, not
 * the view.
 *
 * The charge point filter is the viewer's Charge point group, kept in the URL
 * as `?cp=<id>` (repeated for several): the charge point page links here with
 * its own id, and a reload keeps the choice. Download and Clear act on the
 * selected charge points, on all of them when none is.
 *
 * A **Trace** tab (`?view=trace`) shows the same buffer's OCPP-J frames as
 * Open OCPP Trace records in the trace viewer (`TraceView`), with the same
 * charge point filter. Only the active tab is mounted.
 */
const LogsPage: React.FC = () => {
  const { t } = useTranslation();
  const { config, isLoading } = useConfig();
  const { chargePoints } = useChargePoints(config, { isLoading });
  const { entries, paused, setPaused, clear } = useGlobalLogs();
  const { chargePointService } = useDataContext();

  const [searchParams, setSearchParams] = useSearchParams();
  const selectedCpIds = useMemo(
    () => searchParams.getAll("cp"),
    [searchParams],
  );
  const setSelectedCpIds = (ids: string[]) => {
    const next = new URLSearchParams(searchParams);
    next.delete("cp");
    for (const id of ids) next.append("cp", id);
    setSearchParams(next, { replace: true });
  };
  const view: LogsView = searchParams.get("view") === "trace" ? "trace" : "log";
  const setView = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "trace") next.set("view", "trace");
    else next.delete("view");
    setSearchParams(next, { replace: true });
  };

  // The viewer wants oldest first and `cpId` on the line. It remembers an
  // expanded row by the entry object, so one object per buffer entry is kept
  // across renders instead of a fresh copy each time a line arrives.
  const viewerEntries = useMemo(
    () => new WeakMap<GlobalLogEntry, ViewerLogEntry>(),
    [],
  );
  const logs = useMemo(
    () =>
      [...entries].reverse().map((item) => {
        let line = viewerEntries.get(item);
        if (!line) {
          line = { ...item.entry, cpId: item.cpId };
          viewerEntries.set(item, line);
        }
        return line;
      }),
    [entries, viewerEntries],
  );

  // Whose persisted rows Download and Clear screen + DB reach.
  const scopeIds =
    selectedCpIds.length > 0 ? selectedCpIds : chargePoints.map((cp) => cp.id);

  // The persisted logs, not the on-screen buffer: the filters other than the
  // charge point group do not apply.
  const handleDownload = () => {
    const label =
      selectedCpIds.length === 0
        ? "all"
        : selectedCpIds.length === 1
          ? selectedCpIds[0]
          : "selected";
    void downloadStoredLogs(chargePointService, scopeIds, label).catch(
      (err) => {
        console.error("Failed to download logs", err);
        alert(
          translate("dashboard.logs.downloadFailed", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      },
    );
  };

  const handleClear = (scope: ClearLogsScope) => {
    clear(selectedCpIds);
    if (scope !== "all" || !chargePointService.clearStoredLogs) return;
    // One alert for the lot, not one per charge point.
    const { clearStoredLogs } = chargePointService;
    void Promise.all(
      scopeIds.map((cpId) => clearStoredLogs.call(chargePointService, cpId)),
    ).catch((err) => {
      console.error("Failed to clear stored logs", err);
      alert(
        translate("dashboard.logs.clearFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  };

  return (
    // h-screen: the viewer scrolls its own table, so the page itself must not.
    <div className="flex h-screen flex-col p-6">
      <PageHeader
        title={t("dashboard.logs.title")}
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setPaused(!paused)}
          >
            {paused ? t("dashboard.logs.resume") : t("dashboard.logs.pause")}
          </Button>
        }
      />
      <Tabs
        value={view}
        onValueChange={setView}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList>
          <TabsTrigger value="log">{t("dashboard.logs.tabs.log")}</TabsTrigger>
          <TabsTrigger value="trace">
            {t("dashboard.logs.tabs.trace")}
          </TabsTrigger>
        </TabsList>
        <TabsContent
          value="log"
          className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <LogViewer
            logs={logs}
            selectedCpIds={selectedCpIds}
            onCpFilterChange={setSelectedCpIds}
            onClear={handleClear}
            onDownload={handleDownload}
            className="flex-1"
          />
        </TabsContent>
        <TabsContent
          value="trace"
          className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <Suspense fallback={null}>
            <TraceView
              entries={entries}
              selectedCpIds={selectedCpIds}
              onCpFilterChange={setSelectedCpIds}
            />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default LogsPage;
