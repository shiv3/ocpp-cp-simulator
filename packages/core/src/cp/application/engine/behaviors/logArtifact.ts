import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { collectLogLines } from "../../diagnostics/logLines";

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
  const lines = collectLogLines(cp, window, maxBytes);
  return {
    file: new File([lines.text], fileName, { type: "application/x-ndjson" }),
    entries: lines.entries,
    truncated: lines.truncated,
  };
}
