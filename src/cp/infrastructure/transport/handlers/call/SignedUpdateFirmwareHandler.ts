import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {
  SignedUpdateFirmwareRequestV16,
  SignedUpdateFirmwareResponseV16,
} from "../../../../../ocpp";
import type { HandlerOutcome } from "../../network-sim/ResponseEffectQueue";
import { LogType } from "../../../../shared/Logger";

/**
 * §2 SignedUpdateFirmware.req (OCPP 1.6 Security Whitepaper): the signed
 * counterpart to UpdateFirmware.req (see `UpdateFirmwareHandler`). The
 * response is sent immediately; the simulated download/verify/install
 * train — Downloading → Downloaded → SignatureVerified → Installing →
 * Installed — progresses asynchronously via
 * `ChargePoint.simulateSignedFirmwareUpdate`, carrying the request's
 * `requestId` on every SignedFirmwareStatusNotification. No real
 * signature verification is performed — the simulator has no binary to
 * fetch or signature to check, so `SignatureVerified` always fires on the
 * happy path. `retries` / `retryInterval` are logged but not exercised.
 */
export class SignedUpdateFirmwareHandler implements CallHandler<
  SignedUpdateFirmwareRequestV16,
  SignedUpdateFirmwareResponseV16
> {
  handle(
    payload: SignedUpdateFirmwareRequestV16,
    context: HandlerContext,
  ): SignedUpdateFirmwareResponseV16 | HandlerOutcome {
    const retrieveDate = new Date(payload.firmware.retrieveDateTime);
    if (Number.isNaN(retrieveDate.getTime())) {
      context.logger.warn(
        `SignedUpdateFirmware: invalid retrieveDateTime '${payload.firmware.retrieveDateTime}', starting immediately`,
        LogType.OCPP,
      );
    }
    context.logger.info(
      `SignedUpdateFirmware received: requestId=${payload.requestId}, location=${payload.firmware.location}, retrieveDateTime=${payload.firmware.retrieveDateTime}` +
        (payload.retries != null ? `, retries=${payload.retries}` : "") +
        (payload.retryInterval != null
          ? `, retryInterval=${payload.retryInterval}s`
          : ""),
      LogType.OCPP,
    );

    // §6.19-style contract: response is empty/immediate; the effect defers
    // the simulated train so the CALLRESULT goes out first.
    const startAt = Number.isNaN(retrieveDate.getTime())
      ? new Date()
      : retrieveDate;
    const response = { status: "Accepted" } as const;
    const outcome: HandlerOutcome = {
      kind: "handler-outcome",
      payload: response,
      afterResponseSettled: () =>
        context.chargePoint.simulateSignedFirmwareUpdate(
          startAt,
          payload.requestId,
        ),
    };
    return outcome;
  }
}
