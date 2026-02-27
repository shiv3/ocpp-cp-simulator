/**
 * OCPP 1.6J Smart Charging Handlers
 *
 * IMPORTANT: This is a SIMPLIFIED IMPLEMENTATION for simulator purposes.
 * Several aspects are NOT fully compliant with the OCPP 1.6J specification.
 *
 * Known Non-Compliant Behaviors:
 * ================================
 *
 * 1. ConnectorId=0 Profile Handling:
 *    SPEC: Should store as single charge-point-level profile that applies to entire station
 *    HERE: Duplicates profile to each connector individually
 *    WHY: Simpler implementation, allows per-connector visualization
 *    IMPACT: ClearChargingProfile behavior differs from spec when clearing connector-specific
 *
 * 2. Composite Schedule Calculation:
 *    SPEC: Must calculate MINIMUM limit at each time period across all active profiles
 *          of different purposes (ChargePointMaxProfile, TxDefaultProfile, TxProfile)
 *    HERE: Returns the single "active" profile (highest stack level)
 *    WHY: Complex merging algorithm not needed for basic testing
 *    IMPACT: GetCompositeSchedule returns simplified schedule
 *
 * 3. Profile Purpose Precedence:
 *    SPEC: TxProfile completely overrules TxDefaultProfile (not minimum)
 *          Within same purpose, highest stackLevel wins
 *          Final limit = min(ChargePointMaxProfile, TxProfile OR TxDefaultProfile)
 *    HERE: Simple highest stackLevel selection across all purposes
 *    WHY: Simulator doesn't enforce combined station limits
 *
 * 4. ChargePointMaxProfile Enforcement:
 *    SPEC: Defines OVERALL limit for entire station (sum of all connectors)
 *          Station must ensure total draw doesn't exceed this limit
 *    HERE: Treated as just another profile without total station enforcement
 *    WHY: Requires load balancing logic across connectors
 *
 * 5. Recurring Profile Calculation:
 *    SPEC: Must calculate current period based on Daily/Weekly cycling from startSchedule
 *    HERE: Stores periods as-is without time-based recurrence calculation
 *    WHY: Time-based schedule advancement not implemented
 *
 * For Production Implementation:
 * ================================
 * - Store charge-point-level profiles separately from connector-level
 * - Implement composite schedule merging with min() across purposes
 * - Add load balancing when ChargePointMaxProfile is active
 * - Calculate recurring schedule periods based on elapsed time
 * - Track which profiles originated from connectorId=0 for proper clearing
 */

import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type { Connector } from "../../../../domain/connector/Connector";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import {
  OCPPStatus,
  ChargingProfilePurposeType,
  ChargingProfileKindType,
  ChargingRateUnitType,
  RecurrencyKindType,
} from "../../../../domain/types/OcppTypes";
import { LogType } from "../../../../shared/Logger";
import { defaultConfiguration } from "../../../../domain/charge-point/Configuration";

function getIntegerConfigValue(
  chargePoint: HandlerContext["chargePoint"],
  keyName: string,
  fallback: number,
): number {
  const entry = defaultConfiguration(chargePoint).find(
    (config) => config.key.name === keyName,
  );
  if (!entry) return fallback;
  if (typeof entry.value === "number") return entry.value;
  const parsed = Number.parseInt(String(entry.value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Validate charging profile against OCPP 1.6 spec and configuration
 */
function validateChargingProfile(
  profile: request.ChargingProfile,
  connectorId: number,
  context: HandlerContext,
): { valid: boolean; reason?: string } {
  // Check stack level against configuration
  const maxStackLevel = getIntegerConfigValue(
    context.chargePoint,
    "ChargeProfileMaxStackLevel",
    10,
  );

  if (profile.stackLevel > maxStackLevel) {
    return {
      valid: false,
      reason: `stackLevel ${profile.stackLevel} exceeds max ${maxStackLevel}`,
    };
  }

  // Validate charging profile kind
  const validKinds = Object.values(ChargingProfileKindType);
  if (
    !validKinds.includes(profile.chargingProfileKind as ChargingProfileKindType)
  ) {
    return {
      valid: false,
      reason: `Invalid chargingProfileKind: ${profile.chargingProfileKind}`,
    };
  }

  // Validate charging profile purpose
  const validPurposes = Object.values(ChargingProfilePurposeType);
  if (
    !validPurposes.includes(
      profile.chargingProfilePurpose as ChargingProfilePurposeType,
    )
  ) {
    return {
      valid: false,
      reason: `Invalid chargingProfilePurpose: ${profile.chargingProfilePurpose}`,
    };
  }

  // Validate TxProfile only allowed on specific connector
  if (
    profile.chargingProfilePurpose === ChargingProfilePurposeType.TxProfile &&
    connectorId === 0
  ) {
    return {
      valid: false,
      reason: "TxProfile not allowed on connectorId 0",
    };
  }

  // Validate recurrencyKind for Recurring profiles
  if (profile.chargingProfileKind === ChargingProfileKindType.Recurring) {
    if (!profile.recurrencyKind) {
      return {
        valid: false,
        reason: "recurrencyKind required for Recurring profile",
      };
    }
    const validRecurrency = Object.values(RecurrencyKindType);
    if (
      !validRecurrency.includes(profile.recurrencyKind as RecurrencyKindType)
    ) {
      return {
        valid: false,
        reason: `Invalid recurrencyKind: ${profile.recurrencyKind}`,
      };
    }
  }

  // Validate chargingRateUnit
  const validUnits = Object.values(ChargingRateUnitType);
  if (
    !validUnits.includes(
      profile.chargingSchedule.chargingRateUnit as ChargingRateUnitType,
    )
  ) {
    return {
      valid: false,
      reason: `Invalid chargingRateUnit: ${profile.chargingSchedule.chargingRateUnit}`,
    };
  }

  // Validate schedule periods exist
  if (
    !profile.chargingSchedule.chargingSchedulePeriod ||
    profile.chargingSchedule.chargingSchedulePeriod.length === 0
  ) {
    return {
      valid: false,
      reason: "At least one chargingSchedulePeriod required",
    };
  }

  return { valid: true };
}

/**
 * Check if the currently active charging profile has a zero limit
 */
function isCurrentlyPaused(connector: Connector): boolean {
  const activeProfile = connector.getActiveChargingProfile();
  if (!activeProfile) return false;

  // Simple check: if all periods are zero, it's paused
  return activeProfile.chargingSchedulePeriods.every((p) => p.limit === 0);
}

/**
 * Apply the correct OCPP status after a profile change on a connector.
 *
 * Rules:
 * - Zero-limit active profile + connector is Charging → SuspendedEVSE
 * - Non-zero active profile + connector is SuspendedEVSE + active transaction → Charging
 */
function applyProfileStatus(
  connector: Connector,
  chargePoint: HandlerContext["chargePoint"],
): void {
  const isPaused = isCurrentlyPaused(connector);

  if (isPaused && connector.status === OCPPStatus.Charging) {
    chargePoint.updateConnectorStatus(connector.id, OCPPStatus.SuspendedEVSE);
  } else if (
    !isPaused &&
    connector.status === OCPPStatus.SuspendedEVSE &&
    connector.transaction != null
  ) {
    chargePoint.updateConnectorStatus(connector.id, OCPPStatus.Charging);
  }
}

/**
 * Handler for SetChargingProfile request (OCPP 1.6 SmartCharging)
 *
 * Validates and stores charging profiles on the connector.
 * Supports multi-profile stack management with proper validation.
 * Updates connector status based on active profile limits.
 *
 * NON-COMPLIANT: ConnectorId=0 Handling
 * ======================================
 * SPEC: Should store ONE charge-point-level profile that applies to the entire station
 * HERE: Duplicates the profile to each connector with modified connectorId
 *
 * Impact:
 * - Each connector gets its own copy with the same profileId and stackLevel
 * - ClearChargingProfile with specific connectorId will only clear that connector's copy
 * - For spec-compliant behavior, should store at ChargePoint level and reference during
 *   composite schedule calculation
 *
 * Why this approach:
 * - Simpler implementation for testing/simulation
 * - Allows UI to display profiles per connector
 * - Adequate for CSMS testing that doesn't rely on exact clearing semantics
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

    // Validate the profile
    const validation = validateChargingProfile(
      csChargingProfiles,
      connectorId,
      context,
    );
    if (!validation.valid) {
      context.logger.warn(
        `SetChargingProfile rejected: ${validation.reason}`,
        LogType.OCPP,
      );
      return { status: "Rejected" };
    }

    const periods = csChargingProfiles.chargingSchedule.chargingSchedulePeriod;

    // Build the profile object
    const profile = {
      chargingProfileId: csChargingProfiles.chargingProfileId,
      connectorId,
      stackLevel: csChargingProfiles.stackLevel,
      chargingProfilePurpose:
        csChargingProfiles.chargingProfilePurpose as ChargingProfilePurposeType,
      chargingProfileKind:
        csChargingProfiles.chargingProfileKind as ChargingProfileKindType,
      chargingRateUnit: csChargingProfiles.chargingSchedule
        .chargingRateUnit as ChargingRateUnitType,
      recurrencyKind: csChargingProfiles.recurrencyKind as
        | RecurrencyKindType
        | undefined,
      validFrom: csChargingProfiles.validFrom,
      validTo: csChargingProfiles.validTo,
      chargingSchedulePeriods: periods,
    };

    if (connectorId === 0) {
      // connectorId 0 applies to all connectors
      context.chargePoint.connectors.forEach((connector: Connector) => {
        connector.addChargingProfile({ ...profile, connectorId: connector.id });
        applyProfileStatus(connector, context.chargePoint);
      });
      context.logger.info(
        `Applied charging profile #${profile.chargingProfileId} to all connectors`,
        LogType.OCPP,
      );
    } else {
      const connector = context.chargePoint.getConnector(connectorId);
      if (!connector) {
        context.logger.warn(`Connector ${connectorId} not found`, LogType.OCPP);
        return { status: "Rejected" };
      }
      connector.addChargingProfile(profile);
      applyProfileStatus(connector, context.chargePoint);
      context.logger.info(
        `Applied charging profile #${profile.chargingProfileId} to connector ${connectorId}`,
        LogType.OCPP,
      );
    }

    return { status: "Accepted" };
  }
}

/**
 * Handler for ClearChargingProfile request (OCPP 1.6 SmartCharging)
 *
 * Clears charging profiles based on optional filter criteria:
 * - id: specific profile ID
 * - connectorId: specific connector (or all if omitted)
 * - chargingProfilePurpose: profiles with specific purpose
 * - stackLevel: profiles at specific stack level
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
      `ClearChargingProfile received: id=${payload.id}, connectorId=${payload.connectorId}, purpose=${payload.chargingProfilePurpose}, stackLevel=${payload.stackLevel}`,
      LogType.OCPP,
    );

    let totalCleared = 0;
    const connectors: Connector[] = [];

    // Determine which connectors to clear
    if (payload.connectorId != null) {
      const connector = context.chargePoint.getConnector(payload.connectorId);
      if (connector) {
        connectors.push(connector);
      }
    } else {
      // Clear from all connectors
      context.chargePoint.connectors.forEach((connector) => {
        connectors.push(connector);
      });
    }

    // Build filter criteria
    const criteria: Parameters<Connector["removeChargingProfiles"]>[0] = {};
    if (payload.id != null) {
      criteria.profileId = payload.id;
    }
    if (payload.chargingProfilePurpose != null) {
      criteria.purpose =
        payload.chargingProfilePurpose as ChargingProfilePurposeType;
    }
    if (payload.stackLevel != null) {
      criteria.stackLevel = payload.stackLevel;
    }

    // Apply clearing to each connector
    for (const connector of connectors) {
      const cleared = connector.removeChargingProfiles(criteria);
      totalCleared += cleared;

      if (cleared > 0) {
        context.logger.info(
          `Cleared ${cleared} profile(s) from connector ${connector.id}`,
          LogType.OCPP,
        );
        // Re-evaluate connector status after clearing
        applyProfileStatus(connector, context.chargePoint);
      }
    }

    if (totalCleared === 0) {
      context.logger.info(
        "No profiles matched the clearing criteria",
        LogType.OCPP,
      );
    }

    return { status: "Accepted" };
  }
}

/**
 * Handler for GetCompositeSchedule request (OCPP 1.6 SmartCharging)
 *
 * Returns the effective charging schedule for the requested connector and duration.
 *
 * NON-COMPLIANT: Simplified Composite Schedule Calculation
 * =========================================================
 * SPEC: Must calculate composite by:
 *   1. Find leading profile for each purpose (highest stackLevel)
 *   2. TxProfile completely overrules TxDefaultProfile (not min)
 *   3. Take MINIMUM limit across ChargePointMaxProfile and active Tx profile at each time period
 *   4. For connectorId=0: return TOTAL station power (sum of all connectors + ChargePointMaxProfile)
 *
 * HERE: Returns the single "active" profile (highest valid stackLevel across all purposes)
 *
 * Impact:
 * - Does not merge multiple profiles with min() logic
 * - Does not handle connectorId=0 as total station calculation
 * - Does not apply TxProfile > TxDefaultProfile precedence rules
 * - Adequate for simple CSMS testing but not real load management
 *
 * For Production:
 * - Implement profile merging algorithm per OCPP 1.6 spec section 5.10
 * - Track ChargePointMaxProfile separately
 * - Calculate total for connectorId=0 requests
 * - Handle Recurring profile time calculations
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
    const { connectorId, duration, chargingRateUnit } = payload;

    context.logger.info(
      `GetCompositeSchedule received: connectorId=${connectorId}, duration=${duration}, unit=${chargingRateUnit}`,
      LogType.OCPP,
    );

    const connector = context.chargePoint.getConnector(connectorId);
    if (!connector) {
      context.logger.warn(`Connector ${connectorId} not found`, LogType.OCPP);
      return { status: "Rejected" };
    }

    const activeProfile = connector.getActiveChargingProfile();
    if (!activeProfile) {
      context.logger.info(
        `No active charging profile for connector ${connectorId}`,
        LogType.OCPP,
      );
      return { status: "Rejected" };
    }

    // If chargingRateUnit is specified and doesn't match, we'd need conversion
    // For simplicity, we return the profile's native unit
    const responseUnit = chargingRateUnit || activeProfile.chargingRateUnit;

    if (
      chargingRateUnit &&
      chargingRateUnit !== activeProfile.chargingRateUnit
    ) {
      context.logger.warn(
        `Unit conversion from ${activeProfile.chargingRateUnit} to ${chargingRateUnit} not implemented`,
        LogType.OCPP,
      );
      return { status: "Rejected" };
    }

    // Build the composite schedule from the active profile
    // For now, we return the schedule periods as-is
    // A more complete implementation would merge multiple profiles and trim to duration
    const compositeSchedule = {
      chargingSchedulePeriod: activeProfile.chargingSchedulePeriods.map(
        (period) => ({
          startPeriod: period.startPeriod,
          limit: period.limit,
          numberPhases: period.numberPhases,
        }),
      ),
      duration,
      startSchedule: activeProfile.validFrom || new Date().toISOString(),
      chargingRateUnit: responseUnit,
    };

    context.logger.info(
      `Returning composite schedule for connector ${connectorId} with ${compositeSchedule.chargingSchedulePeriod.length} periods`,
      LogType.OCPP,
    );

    return {
      status: "Accepted",
      connectorId,
      scheduleStart: compositeSchedule.startSchedule,
      chargingSchedule: compositeSchedule,
    };
  }
}
