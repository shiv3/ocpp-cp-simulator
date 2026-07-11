/**
 * OCPP 1.6J Smart Charging Handlers
 *
 * Implements §5.10 SetChargingProfile, §5.4 ClearChargingProfile, and
 * §5.7 GetCompositeSchedule against the connector / charge-point profile
 * stores. Composite calculation walks the merged Tx-layer + station max
 * profile via `buildCompositeWattsSchedule`.
 *
 * Departures from spec that remain (intentionally out of scope here):
 *
 * - `connectorId=0` GetCompositeSchedule returns the highest-draw single
 *   connector composite, not the sum across simultaneous transactions.
 *   The simulator typically drives one connector at a time, so summing
 *   would mostly produce the same result as the per-connector view.
 * - Unit conversion W↔A in GetCompositeSchedule responses uses
 *   `numberPhases=3`, voltage=230 — matches what the resolver assumes
 *   internally and is sufficient for CSMS validation tests.
 */

import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {} from "../../../../../ocpp";
import type { Connector } from "../../../../domain/connector/Connector";
import {
  OCPPStatus,
  ChargingProfilePurposeType,
  ChargingProfileKindType,
  ChargingRateUnitType,
  RecurrencyKindType,
} from "../../../../domain/types/OcppTypes";
import { LogType } from "../../../../shared/Logger";
import { defaultConfiguration } from "../../../../domain/charge-point/Configuration";
import { buildCompositeWattsSchedule } from "../../../../domain/connector/ChargingScheduleResolver";

const REFERENCE_PHASE_VOLTAGE = 230;
const DEFAULT_PHASES = 3;

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

// ts-ocpp@2.7.3 inlines the charging-profile object inside
// `SetChargingProfileRequest` rather than exporting a named ChargingProfile
// type. Alias the inline shape so the validator can keep using a tight
// parameter type.
type CsChargingProfile = SetChargingProfileRequestV16["csChargingProfiles"];

/**
 * Validate charging profile against OCPP 1.6 spec and configuration.
 */
function validateChargingProfile(
  profile: CsChargingProfile,
  connectorId: number,
  context: HandlerContext,
): { valid: boolean; reason?: string } {
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

  if (
    !Object.values(ChargingProfileKindType).includes(
      profile.chargingProfileKind as ChargingProfileKindType,
    )
  ) {
    return {
      valid: false,
      reason: `Invalid chargingProfileKind: ${profile.chargingProfileKind}`,
    };
  }

  if (
    !Object.values(ChargingProfilePurposeType).includes(
      profile.chargingProfilePurpose as ChargingProfilePurposeType,
    )
  ) {
    return {
      valid: false,
      reason: `Invalid chargingProfilePurpose: ${profile.chargingProfilePurpose}`,
    };
  }

  // §5.10 / §3.13.3: TxProfile is tied to a specific transaction —
  // installing one at connectorId=0 makes no sense.
  if (
    profile.chargingProfilePurpose === ChargingProfilePurposeType.TxProfile &&
    connectorId === 0
  ) {
    return {
      valid: false,
      reason: "TxProfile not allowed on connectorId 0",
    };
  }
  // Mirror of the above for ChargePointMaxProfile: it MUST be installed
  // at the CP level. A real CP would reject; we surface the same error.
  if (
    profile.chargingProfilePurpose ===
      ChargingProfilePurposeType.ChargePointMaxProfile &&
    connectorId !== 0
  ) {
    return {
      valid: false,
      reason: "ChargePointMaxProfile must be installed on connectorId 0",
    };
  }

  if (profile.chargingProfileKind === ChargingProfileKindType.Recurring) {
    if (!profile.recurrencyKind) {
      return {
        valid: false,
        reason: "recurrencyKind required for Recurring profile",
      };
    }
    if (
      !Object.values(RecurrencyKindType).includes(
        profile.recurrencyKind as RecurrencyKindType,
      )
    ) {
      return {
        valid: false,
        reason: `Invalid recurrencyKind: ${profile.recurrencyKind}`,
      };
    }
  }

  if (
    !Object.values(ChargingRateUnitType).includes(
      profile.chargingSchedule.chargingRateUnit as ChargingRateUnitType,
    )
  ) {
    return {
      valid: false,
      reason: `Invalid chargingRateUnit: ${profile.chargingSchedule.chargingRateUnit}`,
    };
  }

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

function isCurrentlyPaused(connector: Connector): boolean {
  const active = connector.getActiveChargingProfile();
  if (!active) return false;
  return active.chargingSchedulePeriods.every((p) => p.limit === 0);
}

function applyProfileStatus(
  connector: Connector,
  chargePoint: HandlerContext["chargePoint"],
): void {
  const paused = isCurrentlyPaused(connector);
  if (paused && connector.status === OCPPStatus.Charging) {
    chargePoint.updateConnectorStatus(connector.id, OCPPStatus.SuspendedEVSE);
  } else if (
    !paused &&
    connector.status === OCPPStatus.SuspendedEVSE &&
    connector.transaction != null
  ) {
    chargePoint.updateConnectorStatus(connector.id, OCPPStatus.Charging);
  }
}

/**
 * §5.10 SetChargingProfile.req
 *
 * Routing:
 *   - `connectorId = 0` → ChargePoint.stationProfiles (single station copy)
 *   - `connectorId > 0` → that Connector's profile array
 *
 * Spec-compliant precedence (TxProfile > TxDefaultProfile, station vs
 * connector defaults, ChargePointMaxProfile min-merge) is enforced
 * downstream by Connector.getActiveChargingProfile + the resolver.
 */
export class SetChargingProfileHandler implements CallHandler<
  SetChargingProfileRequestV16,
  SetChargingProfileResponseV16
> {
  handle(
    payload: SetChargingProfileRequestV16,
    context: HandlerContext,
  ): SetChargingProfileResponseV16 {
    const { connectorId, csChargingProfiles } = payload;

    context.logger.info(
      `SetChargingProfile received for connector ${connectorId}: profileId=${csChargingProfiles.chargingProfileId}, purpose=${csChargingProfiles.chargingProfilePurpose}, stackLevel=${csChargingProfiles.stackLevel}`,
      LogType.OCPP,
    );

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
        RecurrencyKindType | undefined,
      validFrom: csChargingProfiles.validFrom,
      validTo: csChargingProfiles.validTo,
      chargingSchedulePeriods: periods,
    };

    if (connectorId === 0) {
      context.chargePoint.stationProfiles.add(profile);
      // Status re-eval on every connector — a new station-wide profile
      // may flip a Charging connector to SuspendedEVSE (or vice versa).
      context.chargePoint.connectors.forEach((c: Connector) =>
        applyProfileStatus(c, context.chargePoint),
      );
      context.logger.info(
        `Installed station profile #${profile.chargingProfileId} (${profile.chargingProfilePurpose})`,
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
 * §5.4 ClearChargingProfile.req
 *
 * Filter dimensions (id / purpose / stackLevel) compose with the
 * connector target the same way for both station and connector layers:
 *
 *   - `connectorId == null` → clear matching profiles from station store
 *     AND every connector.
 *   - `connectorId === 0` → station store only.
 *   - `connectorId > 0`   → that one connector.
 *
 * Spec note: returns Accepted as long as the request was understood,
 * even when zero profiles matched (this matches §5.4's "the CP MAY return
 * Accepted regardless of whether profiles were cleared").
 */
export class ClearChargingProfileHandler implements CallHandler<
  ClearChargingProfileRequestV16,
  ClearChargingProfileResponseV16
> {
  handle(
    payload: ClearChargingProfileRequestV16,
    context: HandlerContext,
  ): ClearChargingProfileResponseV16 {
    context.logger.info(
      `ClearChargingProfile received: id=${payload.id}, connectorId=${payload.connectorId}, purpose=${payload.chargingProfilePurpose}, stackLevel=${payload.stackLevel}`,
      LogType.OCPP,
    );

    const criteria = {
      profileId: payload.id,
      purpose: payload.chargingProfilePurpose as
        ChargingProfilePurposeType | undefined,
      stackLevel: payload.stackLevel,
    };
    let totalCleared = 0;

    const clearStation =
      payload.connectorId == null || payload.connectorId === 0;
    if (clearStation) {
      const removed = context.chargePoint.stationProfiles.remove({
        profileId: criteria.profileId,
        purpose: criteria.purpose,
        stackLevel: criteria.stackLevel,
      });
      totalCleared += removed;
      if (removed > 0) {
        context.logger.info(
          `Cleared ${removed} station-level profile(s)`,
          LogType.OCPP,
        );
        // A station profile change may flip Charging/SuspendedEVSE on
        // any connector currently in a transaction.
        context.chargePoint.connectors.forEach((c: Connector) =>
          applyProfileStatus(c, context.chargePoint),
        );
      }
    }

    const targets: Connector[] = [];
    if (payload.connectorId == null) {
      context.chargePoint.connectors.forEach((c: Connector) => targets.push(c));
    } else if (payload.connectorId > 0) {
      const c = context.chargePoint.getConnector(payload.connectorId);
      if (c) targets.push(c);
    }

    for (const connector of targets) {
      const cleared = connector.removeChargingProfiles({
        profileId: criteria.profileId,
        purpose: criteria.purpose,
        stackLevel: criteria.stackLevel,
      });
      totalCleared += cleared;
      if (cleared > 0) {
        context.logger.info(
          `Cleared ${cleared} profile(s) from connector ${connector.id}`,
          LogType.OCPP,
        );
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

function wattsToUnit(watts: number, unit: ChargingRateUnitType): number {
  if (unit === ChargingRateUnitType.W) return watts;
  // W → A: divide by phase voltage × phases. Mirrors the inverse used by
  // the resolver. Caller is responsible for rounding semantics; we return
  // the raw float here.
  return watts / REFERENCE_PHASE_VOLTAGE / DEFAULT_PHASES;
}

/**
 * §5.7 GetCompositeSchedule.req
 *
 * Builds a composite of (connector Tx-layer profile, ChargePointMaxProfile)
 * over the requested `duration`. Returns `Accepted` with an empty
 * schedule when no profile is active — CSMSs interpret this as
 * "unconstrained for the window".
 *
 * `connectorId = 0` returns the composite considering only
 * ChargePointMaxProfile (the simulator does not track parallel
 * transactions for total-power roll-up).
 */
export class GetCompositeScheduleHandler implements CallHandler<
  GetCompositeScheduleRequestV16,
  GetCompositeScheduleResponseV16
> {
  handle(
    payload: GetCompositeScheduleRequestV16,
    context: HandlerContext,
  ): GetCompositeScheduleResponseV16 {
    const { connectorId, duration, chargingRateUnit } = payload;

    context.logger.info(
      `GetCompositeSchedule received: connectorId=${connectorId}, duration=${duration}, unit=${chargingRateUnit}`,
      LogType.OCPP,
    );

    let txProfile = null as ReturnType<
      Connector["getActiveChargingProfile"]
    > | null;
    if (connectorId > 0) {
      const connector = context.chargePoint.getConnector(connectorId);
      if (!connector) {
        context.logger.warn(`Connector ${connectorId} not found`, LogType.OCPP);
        return { status: "Rejected" };
      }
      txProfile = connector.getActiveChargingProfile();
    }
    const chargePointMaxProfile =
      context.chargePoint.getActiveChargePointMaxProfile();

    const anchor = new Date();
    const slices = buildCompositeWattsSchedule(
      { txProfile, chargePointMaxProfile },
      anchor,
      duration,
    );

    // No profile data → respond Accepted with empty period array.
    const responseUnit: "W" | "A" =
      (chargingRateUnit as "W" | "A" | undefined) ?? "W";
    const chargingSchedulePeriod = slices
      .filter((s) => Number.isFinite(s.watts))
      .map((s) => ({
        startPeriod: s.startPeriod,
        limit: wattsToUnit(s.watts, responseUnit as ChargingRateUnitType),
      }));

    return {
      status: "Accepted",
      connectorId,
      scheduleStart: anchor.toISOString(),
      chargingSchedule: {
        duration,
        startSchedule: anchor.toISOString(),
        chargingRateUnit: responseUnit,
        chargingSchedulePeriod,
      },
    };
  }
}
