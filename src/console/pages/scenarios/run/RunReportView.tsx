import React, { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ScenarioRunResult } from "../../../../cp/application/verification/ScenarioAssertions";
import { useDataContext } from "../../../../data/providers/DataProvider";
import { downloadJson } from "../../../../utils/downloadJson";
import type { TranscriptEntry } from "../../../../cp/application/verification/ScenarioAssertions";
import { formatLogTime } from "../../../lib/useGlobalLogs";
import { formatDurationMs, VERDICT_STYLES } from "./runFormat";

export interface RunReportViewProps {
  cpId: string;
  connectorId: number;
  scenarioId: string;
  runId: string;
}

type ReportState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; report: ScenarioRunResult };

const ASSERTION_STATUS_STYLES: Record<string, string> = {
  passed: "text-cx-emerald",
  failed: "text-cx-rose",
  skipped: "text-cx-muted",
  blocked: "text-cx-amber",
};

/** One transcript message; its payload is serialised only once opened, so a
 *  long transcript does not stringify every payload up front. */
const TranscriptMessage: React.FC<{ entry: TranscriptEntry }> = ({ entry }) => {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer">
        {entry.kind}
        {entry.action ? ` ${entry.action}` : ""}
        {entry.errorCode ? ` ${entry.errorCode}` : ""}{" "}
        <span className="font-mono text-cx-muted">{entry.uniqueId}</span>
      </summary>
      {open && (
        <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px]">
          {JSON.stringify(
            entry.payload ?? entry.errorDescription ?? null,
            null,
            2,
          )}
        </pre>
      )}
    </details>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <section className="mt-4">
    <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-cx-muted">
      {title}
    </h3>
    {children}
  </section>
);

/**
 * One finished run's report (#388): what `scenario_report` returns for
 * `runId` — verdicts, timing, errors, assertion results, the operator's wait
 * interventions and the run's OCPP transcript (its message log). The whole
 * report can be downloaded as JSON.
 */
const RunReportView: React.FC<RunReportViewProps> = ({
  cpId,
  connectorId,
  scenarioId,
  runId,
}) => {
  const { chargePointService } = useDataContext();
  const [state, setState] = useState<ReportState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    chargePointService
      .getScenarioReport(cpId, connectorId, scenarioId, runId)
      .then((report) => {
        if (cancelled) return;
        setState(report ? { status: "ready", report } : { status: "missing" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [chargePointService, cpId, connectorId, scenarioId, runId]);

  if (state.status === "loading") {
    return <p className="text-sm text-cx-muted">Loading…</p>;
  }
  if (state.status === "missing") {
    return (
      <p className="text-sm text-cx-muted">
        The report for run {runId} is no longer available.
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p className="text-sm text-cx-rose">
        Could not load the report: {state.message}
      </p>
    );
  }

  const { report } = state;
  const startedAt = new Date(report.startedAt);
  const endedAt = new Date(report.endedAt);

  return (
    <div className="text-sm" data-testid="run-report">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs font-semibold",
              VERDICT_STYLES[report.verdict],
            )}
          >
            {report.verdict}
          </span>
          <span className="font-mono text-xs text-cx-muted">
            {report.runId}
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            downloadJson(
              report,
              `${report.runId.replace(/[^\w.-]+/g, "_")}.json`,
            )
          }
        >
          Download JSON
        </Button>
      </div>

      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-cx-muted">Target</dt>
        <dd>
          {report.cpId} · C{report.connectorId} ·{" "}
          {report.scenarioName ?? report.scenarioId}
        </dd>
        <dt className="text-cx-muted">Started</dt>
        <dd>{startedAt.toLocaleString()}</dd>
        <dt className="text-cx-muted">Ended</dt>
        <dd>
          {endedAt.toLocaleString()} ({formatDurationMs(report.durationMs)})
        </dd>
        <dt className="text-cx-muted">Execution</dt>
        <dd>
          {report.executionState}
          {report.stopped ? " · stopped by an operator" : ""}
          {report.timeout
            ? ` · timed out on node ${report.timeout.nodeId}`
            : ""}
        </dd>
        <dt className="text-cx-muted">Conformance</dt>
        <dd>{report.conformanceVerdict}</dd>
        <dt className="text-cx-muted">Compatibility</dt>
        <dd>
          {report.compatibilityVerdict}
          {report.strict ? " (strict)" : ""}
        </dd>
      </dl>

      {report.errors.length > 0 && (
        <Section title="Errors">
          <ul className="list-disc pl-5 text-cx-rose">
            {report.errors.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Assertions (${report.assertions.length})`}>
        {report.assertions.length === 0 ? (
          <p className="text-xs text-cx-muted">
            The scenario declares no assertions.
          </p>
        ) : (
          <ul className="space-y-1">
            {report.assertions.map((assertion) => (
              <li key={assertion.id} className="text-xs">
                <span
                  className={cn(
                    "font-semibold",
                    ASSERTION_STATUS_STYLES[assertion.status],
                  )}
                >
                  {assertion.status}
                </span>{" "}
                <span className="font-mono">{assertion.id}</span> —{" "}
                {assertion.description}
                {assertion.detail ? (
                  <span className="text-cx-muted"> ({assertion.detail})</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {report.interventions.length > 0 && (
        <Section title="Wait interventions">
          <ul className="space-y-1 text-xs">
            {report.interventions.map((intervention, index) => (
              <li key={index}>
                {formatLogTime(new Date(intervention.at))} · {intervention.kind}
                {intervention.seconds
                  ? ` +${intervention.seconds} s`
                  : ""} on{" "}
                <span className="font-mono">{intervention.nodeId}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Transcript (${report.transcript.length} messages)`}>
        {report.transcript.length === 0 ? (
          <p className="text-xs text-cx-muted">
            No OCPP message was exchanged during the run.
          </p>
        ) : (
          <div className="max-h-[400px] overflow-auto rounded-lg border border-cx-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-cx-sub text-cx-muted">
                <tr>
                  <th className="px-2 py-1 font-medium">#</th>
                  <th className="px-2 py-1 font-medium">Time</th>
                  <th className="px-2 py-1 font-medium">Dir</th>
                  <th className="px-2 py-1 font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {report.transcript.map((entry) => (
                  <tr
                    key={entry.seq}
                    className="border-t border-cx-border align-top"
                  >
                    <td className="px-2 py-1 font-mono">{entry.seq}</td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      {formatLogTime(new Date(entry.ts))}
                    </td>
                    <td className="px-2 py-1">{entry.direction}</td>
                    <td className="px-2 py-1">
                      <TranscriptMessage entry={entry} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
};

export default RunReportView;
