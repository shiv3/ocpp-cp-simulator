/**
 * Process-wide holder for the `--trace-output` writer (#188). Kept apart from
 * TraceWriter.ts so the CLI never loads the trace SDK (`@open-ocpp-trace/*`,
 * GitHub Packages only) unless a trace feature is actually used: this module
 * only has a type-level reference to TraceWriter.
 */
import type { TraceWriter } from "./TraceWriter";

let globalTraceWriter: TraceWriter | null = null;

export function setGlobalTraceWriter(writer: TraceWriter | null): void {
  globalTraceWriter = writer;
}

export function getGlobalTraceWriter(): TraceWriter | null {
  return globalTraceWriter;
}
