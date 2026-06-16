import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {} from "@cshil/ocpp-tools";
import { UploadFile } from "../../../file_upload";
import { LogType } from "../../../../shared/Logger";

/**
 * §4.4 + §6.7 GetDiagnostics.req: the CALLRESULT returns the upload's
 * target filename, then the CP follows up with a DiagnosticsStatusNotification
 * train — `Uploading` while the POST is in flight, then `Uploaded` /
 * `UploadFailed` on resolution. The actual upload uses
 * `UploadFile(location, file)` which POSTs a multipart form to whatever
 * URL the CSMS supplied (typical scheme: `file://`, `ftp://`, `http://`).
 * Non-HTTP schemes will throw inside `fetch` and we surface that as
 * UploadFailed.
 */
export class GetDiagnosticsHandler
  implements CallHandler<GetDiagnosticsRequestV16, GetDiagnosticsResponseV16>
{
  handle(
    payload: GetDiagnosticsRequestV16,
    context: HandlerContext,
  ): GetDiagnosticsResponseV16 {
    context.logger.info(
      `Get diagnostics request received: ${payload.location}`,
      LogType.DIAGNOSTICS,
    );

    const logs = context.logger.getLogs().join("\n");
    const blob = new Blob([logs], { type: "text/plain" });
    const file = new File([blob], "diagnostics.txt");

    // §4.4: status notifications must follow the CALLRESULT, not precede
    // it. queueMicrotask defers Uploading until the response has been
    // serialized onto the wire (same pattern as TriggerMessage).
    queueMicrotask(() => {
      context.chargePoint.sendDiagnosticsStatusNotification("Uploading");
      void (async () => {
        try {
          const res = await UploadFile(payload.location, file);
          if (!res.ok) {
            context.logger.warn(
              `Diagnostics upload returned HTTP ${res.status}`,
              LogType.DIAGNOSTICS,
            );
            context.chargePoint.sendDiagnosticsStatusNotification(
              "UploadFailed",
            );
            return;
          }
          context.chargePoint.sendDiagnosticsStatusNotification("Uploaded");
        } catch (err) {
          context.logger.warn(
            `Diagnostics upload failed: ${err instanceof Error ? err.message : String(err)}`,
            LogType.DIAGNOSTICS,
          );
          context.chargePoint.sendDiagnosticsStatusNotification("UploadFailed");
        }
      })();
    });

    return { fileName: "diagnostics.txt" };
  }
}
