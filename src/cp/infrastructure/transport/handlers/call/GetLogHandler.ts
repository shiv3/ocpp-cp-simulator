import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type { GetLogRequestV16, GetLogResponseV16 } from "../../../../../ocpp";
import { LogType } from "../../../../shared/Logger";

/**
 * §2 GetLog.req (OCPP 1.6 Security Whitepaper): the CALLRESULT returns the
 * log's target filename, then the CP follows up with a
 * LogStatusNotification train — `Uploading` while the (simulated) upload
 * is in progress, then `Uploaded`. There is no real diagnostics/security
 * log to upload here, so — unlike GetDiagnostics's real `UploadFile` POST
 * — the sequence is purely timer-driven, mirroring
 * `ChargePoint.simulateFirmwareUpdate`'s fixed-interval status train.
 */
export class GetLogHandler
  implements CallHandler<GetLogRequestV16, GetLogResponseV16>
{
  handle(
    payload: GetLogRequestV16,
    context: HandlerContext,
  ): GetLogResponseV16 {
    context.logger.info(
      `GetLog request received: logType=${payload.logType} requestId=${payload.requestId}`,
      LogType.DIAGNOSTICS,
    );

    const filename = `${context.chargePoint.id}-${payload.logType}-${payload.requestId}.log`;

    // §4.4-style contract: status notifications follow the CALLRESULT, not
    // precede it. queueMicrotask defers Uploading until the response has
    // been serialized onto the wire (same pattern as GetDiagnostics).
    queueMicrotask(() => {
      context.chargePoint.sendLogStatusNotification(
        "Uploading",
        payload.requestId,
      );
      setTimeout(() => {
        context.chargePoint.sendLogStatusNotification(
          "Uploaded",
          payload.requestId,
        );
      }, 2000);
    });

    return { status: "Accepted", filename };
  }
}
