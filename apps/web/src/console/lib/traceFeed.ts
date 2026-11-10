/**
 * Feeds the Message Log's trace view (`@open-ocpp-trace/viewer-react`) from
 * the console's own log ring buffer (`GlobalLogsProvider`): each wire line
 * becomes a trace entry with the converter the CLI's TraceWriter uses, so
 * the view shows the same records a `--trace-output` file would hold.
 */
import type { TraceRecord } from "@open-ocpp-trace/core";
import type {
  EntrySource,
  GapEntry,
  TraceEntry,
  ViewerEntry,
} from "@open-ocpp-trace/viewer-core";

import { LogLevel } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import {
  logLineToTraceRecord,
  parseInboundValidation,
  type SerializedLogLine,
} from "@ocpp-cp-simulator/trace/logEntryToTrace";
import { TraceCorrelator } from "@ocpp-cp-simulator/trace/TraceCorrelator";
import type { GlobalLogEntry } from "./globalLogsContext";

/** The producer named in the metadata of every entry. */
export const SIMULATOR_SOURCE: EntrySource = {
  id: "ocpp-cp-simulator",
  label: "OCPP CP Simulator",
};

/** A buffer entry as TraceWriter serializes a log line: ISO timestamp,
 *  level name and the charge point it came from. */
export function toSerializedLogLine({
  cpId,
  entry,
}: GlobalLogEntry): SerializedLogLine {
  return {
    timestamp: entry.timestamp.toISOString(),
    level: LogLevel[entry.level],
    type: entry.type,
    message: entry.message,
    cpId,
  };
}

function traceEntry(seq: number, record: TraceRecord): TraceEntry {
  return {
    kind: "trace",
    id: `sim-seq-${seq}`,
    record,
    metadata: {
      ...(record.chargePointId !== undefined && {
        chargePointId: record.chargePointId,
      }),
      source: SIMULATOR_SOURCE,
    },
  };
}

export interface TraceFeedOptions {
  /** Receives the entries of each delivery that has any, oldest first. */
  push: (entries: readonly ViewerEntry[]) => void;
}

export interface TraceFeed {
  /** Takes the provider's whole buffer (newest first) as it re-renders and
   *  pushes the entries of the lines not seen yet. */
  ingest(buffer: readonly GlobalLogEntry[]): void;
}

/**
 * Ids are `sim-seq-<seq>`, so a line keeps its id however many times the
 * buffer is delivered. Lines that are not OCPP-J frames (application and
 * scenario lines, SOAP exchanges) are skipped: they stay in the log view.
 *
 * When the ring buffer dropped lines between two deliveries (more lines
 * arrived than it holds), a `dropped` gap is listed before the first new
 * line, since some of the dropped lines may have been frames. Pausing the
 * buffer leaves no gap: a paused provider does not number the lines it
 * ignores.
 *
 * A CSMS CALL's inbound validation line is attached as `meta.validation`,
 * as TraceWriter does, when both lines arrive in the same delivery (they
 * are logged one after the other).
 */
export function createTraceFeed({ push }: TraceFeedOptions): TraceFeed {
  // One correlator for every charge point: it keys by charge point, so a
  // CALL on one never back-fills a response on another.
  const correlator = new TraceCorrelator();
  let lastSeq: number | undefined;

  return {
    ingest(buffer) {
      const fresh = buffer
        .filter((item) => lastSeq === undefined || item.seq > lastSeq)
        .sort((a, b) => a.seq - b.seq);
      const first = fresh[0];
      if (first === undefined) return;

      const entries: ViewerEntry[] = [];
      if (lastSeq !== undefined && first.seq > lastSeq + 1) {
        const gap: GapEntry = {
          kind: "gap",
          id: `sim-gap-${first.seq}`,
          reason: "dropped",
          timestamp: first.entry.timestamp.toISOString(),
        };
        entries.push(gap);
      }

      const inboundCalls = new Map<string, TraceRecord>();
      for (const item of fresh) {
        const line = toSerializedLogLine(item);
        const violation = parseInboundValidation(line.message);
        if (violation) {
          const call = inboundCalls.get(
            JSON.stringify([item.cpId, violation.messageId]),
          );
          if (call) {
            call.meta = { ...call.meta, validation: violation.validation };
          }
          continue;
        }
        const record = logLineToTraceRecord(line);
        if (!record) continue;
        correlator.observe(record);
        if (
          record.messageType === "CALL" &&
          record.direction === "csms-to-cp" &&
          record.messageId !== undefined
        ) {
          inboundCalls.set(
            JSON.stringify([item.cpId, record.messageId]),
            record,
          );
        }
        entries.push(traceEntry(item.seq, record));
      }
      lastSeq = fresh[fresh.length - 1]?.seq ?? lastSeq;

      if (entries.length > 0) push(entries);
    },
  };
}
