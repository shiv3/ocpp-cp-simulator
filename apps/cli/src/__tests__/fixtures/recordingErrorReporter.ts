import type {
  ErrorReportContext,
  ErrorReporterInit,
} from "@ocpp-cp-simulator/contracts/errorReporting";

/**
 * A third-party style adapter, loaded by path in errorReporting.test.ts:
 * it records what the core hands it on `globalThis`.
 */
export interface RecordedReports {
  inits: ErrorReporterInit[];
  captured: Array<{ error: unknown; context: ErrorReportContext }>;
}

export async function createErrorReporter(init: ErrorReporterInit) {
  const record = ((
    globalThis as { __recordedReports?: RecordedReports }
  ).__recordedReports ??= { inits: [], captured: [] });
  record.inits.push(init);
  return {
    captureException(error: unknown, context: ErrorReportContext) {
      record.captured.push({ error, context });
    },
    flush: async () => true,
  };
}
