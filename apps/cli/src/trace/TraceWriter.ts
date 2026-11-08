/**
 * Live producer for the OCPP trace format (issue #188 / `--trace-output`):
 * subscribes to a charge point's Logger and appends every OCPP-J wire frame
 * as a JSONL {@link OcppTraceRecord}, so a trace file grows in real time
 * during a run rather than requiring a post-hoc log export + convert step.
 */

import * as fs from "fs";
import { isSoapVersion } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import type { Logger } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import {
  LogLevel,
  type LogEntry,
} from "@ocpp-cp-simulator/core/cp/shared/Logger";
import {
  logLineToTraceRecord,
  parseInboundValidation,
  type SerializedLogLine,
} from "@ocpp-cp-simulator/trace/logEntryToTrace";
import type { OcppTraceRecord } from "@ocpp-cp-simulator/trace/OcppTraceRecord";
import { TraceCorrelator } from "@ocpp-cp-simulator/trace/TraceCorrelator";

export interface TraceWriterAttachContext {
  /** Charge point id stamped on every record from this subscription. */
  cpId: string;
  /** OcppVersion constant, e.g. "OCPP-1.6J" (undefined ⇒ treated as 1.6J). */
  ocppVersion?: string;
  logger: Logger;
}

/** Map an {@link OcppVersion} constant to the plain protocol number the
 *  trace format wants (docs/concepts/trace-format.md), e.g. "OCPP-1.6J" -> "1.6".
 *  Undefined falls back to "1.6", matching `parseOcppVersion`'s fallback. */
export function toTraceOcppVersion(ocppVersion: string | undefined): string {
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

    const write = (record: OcppTraceRecord) =>
      fs.appendFileSync(this.filePath, JSON.stringify(record) + "\n");

    // An inbound CALL is logged before its handler runs, so a schema
    // violation (#593) is only known a moment later. Hold the CALL record back
    // until the next record or the end of the current tick, then write it with
    // `meta.validation` if the charge point reported one.
    let pending: OcppTraceRecord | null = null;
    const flush = () => {
      if (!pending) return;
      const record = pending;
      pending = null;
      try {
        write(record);
      } catch (err) {
        console.warn(
          `[TraceWriter] failed to write trace record to ${this.filePath}`,
          err,
        );
      }
    };

    const listener = (entry: LogEntry) => {
      // Logger.log() emits synchronously, so a runtime I/O failure here
      // (disk full, file replaced, permission revoked) must not propagate
      // out of whatever OCPP code path logged the message — that could
      // crash every charge point sharing this daemon. Same swallow-and-warn
      // convention as persistConnectorRuntime in apps/cli/src/service.ts.
      try {
        const line: SerializedLogLine = {
          timestamp: entry.timestamp.toISOString(),
          level: LogLevel[entry.level],
          type: entry.type,
          message: entry.message,
          cpId: ctx.cpId,
        };
        const violation = parseInboundValidation(line.message);
        if (violation) {
          if (pending && pending.messageId === violation.messageId) {
            pending.meta = {
              ...pending.meta,
              validation: violation.validation,
            };
          }
          return;
        }
        const record = logLineToTraceRecord(line, {
          ocppVersion,
          transport,
          chargePointId: ctx.cpId,
        });
        if (!record) return;
        this.correlator.observe(record);
        flush();
        if (
          record.messageType === "CALL" &&
          record.direction === "csms-to-cp"
        ) {
          pending = record;
          queueMicrotask(flush);
        } else {
          write(record);
        }
      } catch (err) {
        console.warn(
          `[TraceWriter] failed to write trace record to ${this.filePath}`,
          err,
        );
      }
    };

    const off = ctx.logger.on("log.WebSocket", listener);
    return () => {
      off();
      flush();
    };
  }
}

let globalTraceWriter: TraceWriter | null = null;

export function setGlobalTraceWriter(writer: TraceWriter | null): void {
  globalTraceWriter = writer;
}

export function getGlobalTraceWriter(): TraceWriter | null {
  return globalTraceWriter;
}
