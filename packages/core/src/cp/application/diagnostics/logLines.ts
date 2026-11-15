import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import { redactSensitiveText } from "../../shared/redaction";

export interface LogLines {
  /** JSON-lines text, oldest first; starts with `{"truncated":N}` when cut. */
  readonly text: string;
  readonly entries: number;
  readonly truncated: number;
}

/**
 * The charge point's logger entries as JSON lines (`timestamp`, `level`,
 * `type`, `message`; the message redacted), limited to the optional window
 * and bounded to `maxBytes` by dropping the oldest entries. Shared by the
 * GetLog log file (#926) and the diagnostic bundle (#925).
 */
export function collectLogLines(
  cp: ChargePoint,
  window: {
    oldestTimestamp?: string | undefined;
    latestTimestamp?: string | undefined;
  },
  maxBytes: number,
): LogLines {
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
    text: kept.length ? kept.join("\n") + "\n" : "",
    entries: lines.length - keepFrom,
    truncated: keepFrom,
  };
}
