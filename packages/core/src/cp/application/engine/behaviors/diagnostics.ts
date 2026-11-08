import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { UploadFile } from "../../../infrastructure/file_upload";
import { LogType } from "../../../shared/Logger";

/** How long one upload attempt may take before it counts as failed. */
const ATTEMPT_TIMEOUT_MS = 60_000;
/** Wait between attempts when the request names `retries` but no
 *  `retryInterval` (§6.25: the station decides). */
const DEFAULT_RETRY_INTERVAL_S = 30;

interface GetDiagnosticsRequest {
  location: string;
  retries?: number;
  retryInterval?: number;
  startTime?: string;
  stopTime?: string;
}

/** The log lines (`[ISO time] ...`) inside `startTime`..`stopTime`; lines
 *  without a leading timestamp stay. */
export function linesBetween(
  lines: readonly string[],
  startTime?: string,
  stopTime?: string,
): string[] {
  const from = startTime ? Date.parse(startTime) : Number.NaN;
  const to = stopTime ? Date.parse(stopTime) : Number.NaN;
  if (Number.isNaN(from) && Number.isNaN(to)) return [...lines];
  return lines.filter((line) => {
    const stamp = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/.exec(line)?.[1];
    const at = stamp ? Date.parse(stamp) : Number.NaN;
    if (Number.isNaN(at)) return true;
    return (Number.isNaN(from) || at >= from) && (Number.isNaN(to) || at <= to);
  });
}

/**
 * The default behavior of GetDiagnostics.req (OCPP 1.6 §4.4, §6.7): the
 * response names the file the station uploads; once it settled, the station
 * sends DiagnosticsStatusNotification `Uploading` while the POST is in flight,
 * then `Uploaded` or `UploadFailed`. The upload is `UploadFile(location,
 * file)`, a multipart POST to the URL the CSMS gave; a scheme `fetch` cannot
 * speak surfaces as `UploadFailed`.
 *
 * `retries` (§6.25, errata 3.50) is how many times the station retries after
 * the first attempt before giving up, `retryInterval` the seconds between
 * attempts (30 when absent); without `retries` there is one attempt. Each
 * attempt times out after 60 s. `Uploading` goes out once and one final
 * `Uploaded` / `UploadFailed` ends the run. `startTime` / `stopTime` limit the
 * uploaded log lines to that window.
 */
export function diagnosticsBehavior(cp: ChargePoint): Behavior {
  return {
    api: 1,
    id: "default.diagnostics",
    onCall: {
      GetDiagnostics: {
        mode: "replace",
        handle: (request, ctx) => {
          const { location, retries, retryInterval, startTime, stopTime } =
            request as GetDiagnosticsRequest;
          cp.logger.info(
            `Get diagnostics request received: ${location}`,
            LogType.DIAGNOSTICS,
          );
          const logs = linesBetween(
            cp.logger.getLogs(),
            startTime,
            stopTime,
          ).join("\n");
          const file = new File(
            [new Blob([logs], { type: "text/plain" })],
            "diagnostics.txt",
          );
          return {
            response: { fileName: "diagnostics.txt" },
            after: async () => {
              ctx.notify.diagnosticsStatus("Uploading");
              const attempts = 1 + Math.max(0, Math.trunc(retries ?? 0));
              const intervalMs =
                Math.max(0, retryInterval ?? DEFAULT_RETRY_INTERVAL_S) * 1000;
              for (let attempt = 1; attempt <= attempts; attempt++) {
                const abort = new AbortController();
                try {
                  const upload = UploadFile(location, file, abort.signal);
                  // A rejection after the timeout is the abort itself.
                  upload.catch(() => undefined);
                  const res = await ctx.until(upload, {
                    ms: ATTEMPT_TIMEOUT_MS,
                  });
                  if (res.ok) {
                    ctx.notify.diagnosticsStatus("Uploaded");
                    return;
                  }
                  cp.logger.warn(
                    `Diagnostics upload returned HTTP ${res.status} (attempt ${attempt}/${attempts})`,
                    LogType.DIAGNOSTICS,
                  );
                } catch (err) {
                  abort.abort();
                  // The station stopped: no final status.
                  if (ctx.stopping) throw err;
                  cp.logger.warn(
                    `Diagnostics upload failed: ${err instanceof Error ? err.message : String(err)} (attempt ${attempt}/${attempts})`,
                    LogType.DIAGNOSTICS,
                  );
                }
                if (attempt < attempts) await ctx.sleep(intervalMs);
              }
              ctx.notify.diagnosticsStatus("UploadFailed");
            },
          };
        },
      },
    },
  };
}
