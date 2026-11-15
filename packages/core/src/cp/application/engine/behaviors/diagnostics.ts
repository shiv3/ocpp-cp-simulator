import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { LogType } from "../../../shared/Logger";
import { uploadWithRetries } from "./uploadRetry";

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
 * then `Uploaded` or `UploadFailed`. The upload is
 * `cp.fileUploader(location, file)`, by default a multipart POST to the URL
 * the CSMS gave; a scheme `fetch` cannot speak surfaces as `UploadFailed`.
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
              const done = await uploadWithRetries({
                cp,
                ctx,
                upload: cp.fileUploader,
                location,
                file,
                retries,
                retryInterval,
                label: "Diagnostics",
              });
              ctx.notify.diagnosticsStatus(done ? "Uploaded" : "UploadFailed");
            },
          };
        },
      },
    },
  };
}
