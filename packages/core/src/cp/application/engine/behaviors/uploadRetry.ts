import type { BehaviorContext } from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { FileUploader } from "../../../domain/charge-point/FileUploader";
import { LogType } from "../../../shared/Logger";

/** How long one upload attempt may take before it counts as failed. */
export const ATTEMPT_TIMEOUT_MS = 60_000;
/** Wait between attempts when the request names `retries` but no
 *  `retryInterval` (the station decides). */
export const DEFAULT_RETRY_INTERVAL_S = 30;
/** Upper bound for the retries of one GetLog request, so a CSMS-supplied
 *  `retries` cannot keep the station uploading forever (#926). GetDiagnostics
 *  keeps honoring `retries` as given (#743). */
export const MAX_LOG_UPLOAD_RETRIES = 10;

export interface UploadRetryOptions {
  readonly cp: ChargePoint;
  readonly ctx: Pick<BehaviorContext, "until" | "sleep" | "stopping">;
  readonly upload: FileUploader;
  readonly location: string;
  readonly file: File;
  readonly retries?: number | undefined;
  readonly retryInterval?: number | undefined;
  /** Cap on `retries`; none when absent. */
  readonly maxRetries?: number;
  /** Prefix of the log lines (`Diagnostics`, `Log`). */
  readonly label: string;
  /** Checked before each attempt: true stops the run without a result
   *  (another request replaced this one). */
  readonly superseded?: () => boolean;
  /** Called with the attempt number, 1-based, before each attempt. */
  readonly onAttempt?: (attempt: number) => void;
}

/**
 * The attempt loop shared by GetDiagnostics (1.6 §6.25, errata 3.50) and
 * GetLog (#926): `retries` is how many times the station retries after the
 * first attempt, `retryInterval` the seconds between attempts; each attempt
 * times out after {@link ATTEMPT_TIMEOUT_MS}. Returns true on the first 2xx,
 * false once every attempt failed, `"superseded"` when `superseded()` turned
 * true. A station stop rethrows (no final status).
 */
export async function uploadWithRetries(
  o: UploadRetryOptions,
): Promise<boolean | "superseded"> {
  const retries = Math.min(
    o.maxRetries ?? Number.POSITIVE_INFINITY,
    Math.max(0, Math.trunc(o.retries ?? 0)),
  );
  const attempts = 1 + retries;
  const intervalMs =
    Math.max(0, o.retryInterval ?? DEFAULT_RETRY_INTERVAL_S) * 1000;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (o.superseded?.()) return "superseded";
    o.onAttempt?.(attempt);
    const abort = new AbortController();
    try {
      const upload = o.upload(o.location, o.file, abort.signal);
      // A rejection after the timeout is the abort itself.
      upload.catch(() => undefined);
      const res = await o.ctx.until(upload, { ms: ATTEMPT_TIMEOUT_MS });
      if (res.ok) return o.superseded?.() ? "superseded" : true;
      o.cp.logger.warn(
        `${o.label} upload returned HTTP ${res.status} (attempt ${attempt}/${attempts})`,
        LogType.DIAGNOSTICS,
      );
    } catch (err) {
      abort.abort();
      // The station stopped: no final status.
      if (o.ctx.stopping) throw err;
      o.cp.logger.warn(
        `${o.label} upload failed: ${err instanceof Error ? err.message : String(err)} (attempt ${attempt}/${attempts})`,
        LogType.DIAGNOSTICS,
      );
    }
    if (attempt < attempts) await o.ctx.sleep(intervalMs);
  }
  return o.superseded?.() ? "superseded" : false;
}
