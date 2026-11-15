import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { redactSensitiveText } from "../../../shared/redaction";

/** Upper bound for the uploaded log file (#926). The newest entries stay. */
export const MAX_LOG_ARTIFACT_BYTES = 1024 * 1024;

export interface LogArtifact {
  readonly file: File;
  /** Entries in the file. */
  readonly entries: number;
  /** Entries left out because of the size bound (the oldest). */
  readonly truncated: number;
}

/**
 * The structured log file a real GetLog uploads (#926): one JSON object per
 * line (`timestamp`, `level`, `type`, `message`) from the charge point's
 * logger, limited to `oldestTimestamp`..`latestTimestamp` when the request
 * names them, secrets in the message redacted, and bounded to
 * {@link MAX_LOG_ARTIFACT_BYTES}: when it would be larger the oldest entries
 * are dropped and the first line says how many (`{"truncated": N}`).
 */
export function buildLogArtifact(
  cp: ChargePoint,
  fileName: string,
  window: { oldestTimestamp?: string; latestTimestamp?: string },
  maxBytes: number = MAX_LOG_ARTIFACT_BYTES,
): LogArtifact {
  const from = window.oldestTimestamp
    ? Date.parse(window.oldestTimestamp)
    : Number.NaN;
  const to = window.latestTimestamp
    ? Date.parse(window.latestTimestamp)
    : Number.NaN;
  const lines: string[] = [];
  for (const entry of cp.logger.getLogEntries()) {
    const at = entry.timestamp.getTime();
    if (!Number.isNaN(from) && at < from) continue;
    if (!Number.isNaN(to) && at > to) continue;
    lines.push(
      JSON.stringify({
        timestamp: entry.timestamp.toISOString(),
        level: ["DEBUG", "INFO", "WARN", "ERROR"][entry.level] ?? entry.level,
        type: entry.type,
        message: redactSensitiveText(entry.message),
      }),
    );
  }
  const encoder = new TextEncoder();
  let bytes = 0;
  let keepFrom = lines.length;
  while (keepFrom > 0) {
    const size = encoder.encode(lines[keepFrom - 1]!).length + 1;
    if (bytes + size > maxBytes) break;
    bytes += size;
    keepFrom--;
  }
  const kept = lines.slice(keepFrom);
  if (keepFrom > 0) kept.unshift(JSON.stringify({ truncated: keepFrom }));
  return {
    file: new File([kept.join("\n") + (kept.length ? "\n" : "")], fileName, {
      type: "application/x-ndjson",
    }),
    entries: lines.length - keepFrom,
    truncated: keepFrom,
  };
}
