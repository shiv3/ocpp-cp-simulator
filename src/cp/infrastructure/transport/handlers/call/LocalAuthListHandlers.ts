import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { LogType } from "../../../../shared/Logger";
import type { SendLocalListItem } from "../../../../domain/auth/LocalAuthList";

/**
 * `LocalAuthListEnabled` defaults to `true` when missing (the key is
 * seeded by defaultConfiguration, but defending against a configuration
 * delete is cheap).
 */
function isFeatureEnabled(context: HandlerContext): boolean {
  return (
    context.chargePoint.configuration.getBoolean("LocalAuthListEnabled") ?? true
  );
}

function maxListLength(context: HandlerContext): number {
  return (
    context.chargePoint.configuration.getInteger("LocalAuthListMaxLength") ??
    1000
  );
}

function maxSendLength(context: HandlerContext): number {
  return (
    context.chargePoint.configuration.getInteger("SendLocalListMaxLength") ??
    100
  );
}

/**
 * §6.10 GetLocalListVersion.req — returns the current list version, or
 * `-1` when LocalAuthListManagement is disabled in Configuration.
 */
export class GetLocalListVersionHandler
  implements
    CallHandler<
      request.GetLocalListVersionRequest,
      response.GetLocalListVersionResponse
    >
{
  handle(
    _payload: request.GetLocalListVersionRequest,
    context: HandlerContext,
  ): response.GetLocalListVersionResponse {
    if (!isFeatureEnabled(context)) {
      context.logger.info(
        "GetLocalListVersion: LocalAuthListEnabled=false, returning -1",
        LogType.OCPP,
      );
      return { listVersion: -1 };
    }
    const listVersion = context.chargePoint.localAuthListManager.getVersion();
    context.logger.info(`GetLocalListVersion → ${listVersion}`, LogType.OCPP);
    return { listVersion };
  }
}

/**
 * §6.18 SendLocalList.req — Full replaces the entire list; Differential
 * upserts entries (and deletes those whose `idTagInfo` is omitted). The
 * CP returns `NotSupported` when LocalAuthListManagement is disabled.
 */
export class SendLocalListHandler
  implements
    CallHandler<request.SendLocalListRequest, response.SendLocalListResponse>
{
  handle(
    payload: request.SendLocalListRequest,
    context: HandlerContext,
  ): response.SendLocalListResponse {
    if (!isFeatureEnabled(context)) {
      context.logger.warn(
        "SendLocalList: LocalAuthListEnabled=false → NotSupported",
        LogType.OCPP,
      );
      return { status: "NotSupported" };
    }
    const limits = {
      localAuthListMaxLength: maxListLength(context),
      sendLocalListMaxLength: maxSendLength(context),
    };
    // ts-ocpp permits unknown extra fields on idTagInfo via [k: string]:
    // unknown. Narrow to the subset the manager actually reads — runtime
    // shape matches because idTag is a top-level required field and
    // status lives at the documented path.
    const items = payload.localAuthorizationList as
      | SendLocalListItem[]
      | undefined;

    const manager = context.chargePoint.localAuthListManager;
    const status =
      payload.updateType === "Full"
        ? manager.applyFull(payload.listVersion, items, limits)
        : manager.applyDifferential(payload.listVersion, items, limits);

    context.logger.info(
      `SendLocalList (${payload.updateType}, version=${payload.listVersion}, items=${items?.length ?? 0}) → ${status}`,
      LogType.OCPP,
    );
    return { status };
  }
}
