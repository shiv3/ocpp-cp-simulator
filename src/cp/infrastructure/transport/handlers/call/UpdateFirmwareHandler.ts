import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { LogType } from "../../../../shared/Logger";

/**
 * §6.19 UpdateFirmware.req — the spec's response is an empty payload; the
 * actual update progresses asynchronously via FirmwareStatusNotification.
 * Because the simulator has no real binary to fetch, we just schedule the
 * status sequence (Downloading → Downloaded → Installing → Installed) so
 * the CSMS sees the same external observable as a real CP would on the
 * happy path. `retries` / `retryInterval` are logged but not exercised —
 * the simulated flow never fails. CSMS can still test the failure paths
 * via TriggerMessage(FirmwareStatusNotification).
 */
export class UpdateFirmwareHandler
  implements
    CallHandler<request.UpdateFirmwareRequest, response.UpdateFirmwareResponse>
{
  handle(
    payload: request.UpdateFirmwareRequest,
    context: HandlerContext,
  ): response.UpdateFirmwareResponse {
    const retrieveDate = new Date(payload.retrieveDate);
    if (Number.isNaN(retrieveDate.getTime())) {
      context.logger.warn(
        `UpdateFirmware: invalid retrieveDate '${payload.retrieveDate}', starting immediately`,
        LogType.OCPP,
      );
    }
    context.logger.info(
      `UpdateFirmware received: location=${payload.location}, retrieveDate=${payload.retrieveDate}` +
        (payload.retries != null ? `, retries=${payload.retries}` : "") +
        (payload.retryInterval != null
          ? `, retryInterval=${payload.retryInterval}s`
          : ""),
      LogType.OCPP,
    );

    // §6.19: response is empty and sent immediately. Defer the simulated
    // download train so the CALLRESULT goes out first — same pattern as
    // TriggerMessage handler.
    const startAt = Number.isNaN(retrieveDate.getTime())
      ? new Date()
      : retrieveDate;
    queueMicrotask(() => context.chargePoint.simulateFirmwareUpdate(startAt));

    return {};
  }
}
