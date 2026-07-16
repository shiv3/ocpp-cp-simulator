/**
 * Live producer for the OCPP trace format (issue #188 / `--trace-output`):
 * subscribes to a charge point's Logger and appends every OCPP-J wire frame
 * as a JSONL {@link OcppTraceRecord}, so a trace file grows in real time
 * during a run rather than requiring a post-hoc log export + convert step.
 */

import * as fs from "fs";
import { isSoapVersion } from "../../cp/domain/types/OcppVersion";
import { Logger, LogLevel, type LogEntry } from "../../cp/shared/Logger";
import {
  logLineToTraceRecord,
  type SerializedLogLine,
} from "../../trace/logEntryToTrace";
import { TraceCorrelator } from "../../trace/TraceCorrelator";

export interface TraceWriterAttachContext {
  /** Charge point id stamped on every record from this subscription. */
  cpId: string;
  /** OcppVersion constant, e.g. "OCPP-1.6J" (undefined ⇒ treated as 1.6J). */
  ocppVersion?: string;
  logger: Logger;
}

/** Map an {@link OcppVersion} constant to the plain protocol number the
 *  trace format wants (docs/trace-format.md), e.g. "OCPP-1.6J" -> "1.6".
 *  Undefined falls back to "1.6", matching `parseOcppVersion`'s fallback. */
function toTraceOcppVersion(ocppVersion: string | undefined): string {
  switch (ocppVersion) {
    case "OCPP-1.2":
      return "1.2";
    case "OCPP-1.5":
      return "1.5";
    case "OCPP-2.0.1":
      return "2.0.1";
    case "OCPP-2.1":
      return "2.1";
    case "OCPP-1.6S":
    case "OCPP-1.6J":
    default:
      return "1.6";
  }
}

export class TraceWriter {
  // Shared across every attach()ed charge point so a CALL on one CP never
  // back-fills a CALLRESULT on another (TraceCorrelator scopes its key by
  // chargePointId), while still letting one writer serve a whole daemon.
  private readonly correlator = new TraceCorrelator();

  constructor(private readonly filePath: string) {
    // Eagerly touch the file: a bad path (missing parent dir, no
    // permission) fails at startup instead of silently dropping every
    // record later, and the file exists even if the run never produces a
    // wire message.
    fs.appendFileSync(filePath, "");
  }

  attach(ctx: TraceWriterAttachContext): () => void {
    const transport = isSoapVersion(ctx.ocppVersion) ? "soap" : "json";
    const ocppVersion = toTraceOcppVersion(ctx.ocppVersion);

    const listener = (entry: LogEntry) => {
      const line: SerializedLogLine = {
        timestamp: entry.timestamp.toISOString(),
        level: LogLevel[entry.level],
        type: entry.type,
        message: entry.message,
        cpId: ctx.cpId,
      };
      const record = logLineToTraceRecord(line, {
        ocppVersion,
        transport,
        chargePointId: ctx.cpId,
      });
      if (!record) return;
      this.correlator.observe(record);
      fs.appendFileSync(this.filePath, JSON.stringify(record) + "\n");
    };

    return ctx.logger.on("log.WebSocket", listener);
  }
}

let globalTraceWriter: TraceWriter | null = null;

export function setGlobalTraceWriter(writer: TraceWriter | null): void {
  globalTraceWriter = writer;
}

export function getGlobalTraceWriter(): TraceWriter | null {
  return globalTraceWriter;
}
