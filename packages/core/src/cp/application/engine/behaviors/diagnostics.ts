import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { UploadFile } from "../../../infrastructure/file_upload";
import { LogType } from "../../../shared/Logger";

interface GetDiagnosticsRequest {
  location: string;
}

/**
 * The default behavior of GetDiagnostics.req (OCPP 1.6 §4.4, §6.7): the
 * response names the file the station uploads; once it settled, the station
 * sends DiagnosticsStatusNotification `Uploading` while the POST is in flight,
 * then `Uploaded` or `UploadFailed`. The upload is `UploadFile(location,
 * file)`, a multipart POST to the URL the CSMS gave; a scheme `fetch` cannot
 * speak surfaces as `UploadFailed`.
 */
export function diagnosticsBehavior(cp: ChargePoint): Behavior {
  return {
    api: 1,
    id: "default.diagnostics",
    onCall: {
      GetDiagnostics: {
        mode: "replace",
        handle: (request, ctx) => {
          const { location } = request as GetDiagnosticsRequest;
          cp.logger.info(
            `Get diagnostics request received: ${location}`,
            LogType.DIAGNOSTICS,
          );
          const logs = cp.logger.getLogs().join("\n");
          const file = new File(
            [new Blob([logs], { type: "text/plain" })],
            "diagnostics.txt",
          );
          return {
            response: { fileName: "diagnostics.txt" },
            after: async () => {
              ctx.notify.diagnosticsStatus("Uploading");
              try {
                const res = await UploadFile(location, file);
                if (!res.ok) {
                  cp.logger.warn(
                    `Diagnostics upload returned HTTP ${res.status}`,
                    LogType.DIAGNOSTICS,
                  );
                  ctx.notify.diagnosticsStatus("UploadFailed");
                  return;
                }
                ctx.notify.diagnosticsStatus("Uploaded");
              } catch (err) {
                cp.logger.warn(
                  `Diagnostics upload failed: ${err instanceof Error ? err.message : String(err)}`,
                  LogType.DIAGNOSTICS,
                );
                ctx.notify.diagnosticsStatus("UploadFailed");
              }
            },
          };
        },
      },
    },
  };
}
