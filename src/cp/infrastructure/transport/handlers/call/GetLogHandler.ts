import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type { HandlerOutcome } from "../../network-sim/ResponseEffectQueue";
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
export class GetLogHandler implements CallHandler<
  GetLogRequestV16,
  GetLogResponseV16
> {
  handle(
    payload: GetLogRequestV16,
    context: HandlerContext,
  ): GetLogResponseV16 | HandlerOutcome {
    context.logger.info(
      `GetLog request received: logType=${payload.logType} requestId=${payload.requestId}`,
      LogType.DIAGNOSTICS,
    );

    const filename = `${context.chargePoint.id}-${payload.logType}-${payload.requestId}.log`;
    const response = { status: "Accepted", filename } as const;
    const outcome: HandlerOutcome = {
      kind: "handler-outcome",
      payload: response,
      afterResponseSettled: () => {
        // §4.4-style contract: status notifications follow the CALLRESULT, not
        // precede it. The effect defers Uploading until the response has
        // been settled on the wire (same pattern as GetDiagnostics).
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
      },
    };
    return outcome;
  }
}
