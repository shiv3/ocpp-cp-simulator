import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type { Connector } from "../../../../domain/connector/Connector";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { OCPPStatus } from "../../../../domain/types/OcppTypes";
import { LogType } from "../../../../shared/Logger";

/** Returns true when every schedule period has a zero limit (i.e. charging is paused). */
function isZeroLimitProfile(periods: Array<{ limit: number }>): boolean {
  return periods.length > 0 && periods.every((p) => p.limit === 0);
}

/**
 * Apply the correct OCPP status after a profile is set or cleared on a connector.
 *
 * Rules:
 * - Zero-limit profile + connector is Charging → SuspendedEVSE
 * - Non-zero / cleared profile + connector is SuspendedEVSE + active transaction → Charging
 */
function applyProfileStatus(
  connector: Connector,
  chargePoint: HandlerContext["chargePoint"],
  isPausing: boolean,
): void {
  if (isPausing && connector.status === OCPPStatus.Charging) {
    chargePoint.updateConnectorStatus(connector.id, OCPPStatus.SuspendedEVSE);
  } else if (
    !isPausing &&
    connector.status === OCPPStatus.SuspendedEVSE &&
    connector.transaction != null
  ) {
    chargePoint.updateConnectorStatus(connector.id, OCPPStatus.Charging);
  }
}

/**
 * Handler for SetChargingProfile request (OCPP 1.6 SmartCharging)
 *
 * Accepts the charging profile and stores it on the connector so the
 * front-end can display the effective limit (e.g. a "pause" zero-limit profile).
 * Emits SuspendedEVSE when all schedule periods carry a zero limit, and
 * restores Charging when a non-zero profile replaces a paused one.
 */
export class SetChargingProfileHandler
  implements
    CallHandler<
      request.SetChargingProfileRequest,
      response.SetChargingProfileResponse
    >
{
  handle(
    payload: request.SetChargingProfileRequest,
    context: HandlerContext,
  ): response.SetChargingProfileResponse {
    const { connectorId, csChargingProfiles } = payload;
    context.logger.info(
      `SetChargingProfile received for connector ${connectorId}: profileId=${csChargingProfiles.chargingProfileId}, purpose=${csChargingProfiles.chargingProfilePurpose}, stackLevel=${csChargingProfiles.stackLevel}`,
      LogType.OCPP,
    );

    const periods = csChargingProfiles.chargingSchedule.chargingSchedulePeriod;
    const isPausing = isZeroLimitProfile(periods);

    const profile = {
      chargingProfileId: csChargingProfiles.chargingProfileId,
      connectorId,
      stackLevel: csChargingProfiles.stackLevel,
      chargingProfilePurpose: csChargingProfiles.chargingProfilePurpose,
      chargingProfileKind: csChargingProfiles.chargingProfileKind,
      chargingRateUnit: csChargingProfiles.chargingSchedule.chargingRateUnit,
      chargingSchedulePeriods: periods,
    };

    if (connectorId === 0) {
      // connectorId 0 applies to all connectors
      context.chargePoint.connectors.forEach((connector: Connector) => {
        connector.chargingProfile = { ...profile, connectorId: connector.id };
        applyProfileStatus(connector, context.chargePoint, isPausing);
      });
    } else {
      const connector = context.chargePoint.getConnector(connectorId);
      if (connector) {
        connector.chargingProfile = profile;
        applyProfileStatus(connector, context.chargePoint, isPausing);
      }
    }

    return { status: "Accepted" };
  }
}

/**
 * Handler for ClearChargingProfile request (OCPP 1.6 SmartCharging)
 *
 * Clears a previously set charging profile. If the connector was in
 * SuspendedEVSE due to a zero-limit profile and has an active transaction,
 * it is restored to Charging automatically.
 */
export class ClearChargingProfileHandler
  implements
    CallHandler<
      request.ClearChargingProfileRequest,
      response.ClearChargingProfileResponse
    >
{
  handle(
    payload: request.ClearChargingProfileRequest,
    context: HandlerContext,
  ): response.ClearChargingProfileResponse {
    context.logger.info(
      `ClearChargingProfile received: id=${payload.id}, connectorId=${payload.connectorId}, purpose=${payload.chargingProfilePurpose}`,
      LogType.OCPP,
    );

    if (payload.connectorId != null) {
      const connector = context.chargePoint.getConnector(payload.connectorId);
      if (connector) {
        connector.chargingProfile = null;
        applyProfileStatus(connector, context.chargePoint, false);
      }
    } else {
      // No connectorId means clear all
      context.chargePoint.connectors.forEach((connector: Connector) => {
        connector.chargingProfile = null;
        applyProfileStatus(connector, context.chargePoint, false);
      });
    }

    return { status: "Accepted" };
  }
}

/**
 * Handler for GetCompositeSchedule request (OCPP 1.6 SmartCharging)
 *
 * Returns the effective charging schedule for the requested connector and duration.
 * Currently reports no active schedule (Rejected), which is the safe default when
 * profile management is not tracked in memory.
 */
export class GetCompositeScheduleHandler
  implements
    CallHandler<
      request.GetCompositeScheduleRequest,
      response.GetCompositeScheduleResponse
    >
{
  handle(
    payload: request.GetCompositeScheduleRequest,
    context: HandlerContext,
  ): response.GetCompositeScheduleResponse {
    context.logger.info(
      `GetCompositeSchedule received: connectorId=${payload.connectorId}, duration=${payload.duration}`,
      LogType.OCPP,
    );
    return { status: "Rejected" };
  }
}
