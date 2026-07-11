import type {
  ClearChargingProfileRequestV201,
  ClearChargingProfileResponseV201,
  GetChargingProfilesRequestV201,
  GetChargingProfilesResponseV201,
  GetCompositeScheduleRequestV201,
  GetCompositeScheduleResponseV201,
  SetChargingProfileRequestV201,
  SetChargingProfileResponseV201,
} from "../../../../ocpp";
import type {
  ChargingProfileType as ReportChargingProfileType,
  ReportChargingProfilesRequestV201,
} from "../../../../ocpp/v201/types/report-charging-profiles-request";
import type {
  ActiveChargingProfile,
  Connector,
} from "../../../domain/connector/Connector";
import { buildCompositeWattsSchedule } from "../../../domain/connector/ChargingScheduleResolver";
import {
  ChargingProfileKindType,
  ChargingProfilePurposeType,
  ChargingRateUnitType,
  OCPPStatus,
  RecurrencyKindType,
} from "../../../domain/types/OcppTypes";
import type {
  V201HandlerResult,
  V201InboundContext,
} from "./inboundRegistryV201";

const REFERENCE_PHASE_VOLTAGE = 230;
const DEFAULT_PHASES = 3;
const REPORT_SOURCE = "CSO";
const REPRESENTABLE_PERIOD_KEYS = new Set([
  "startPeriod",
  "limit",
  "numberPhases",
  "phaseToUse",
  "customData",
]);

type IncomingChargingProfile = {
  id: number;
  stackLevel: number;
  chargingProfilePurpose: string;
  chargingProfileKind: string;
  recurrencyKind?: string;
  validFrom?: string;
  validTo?: string;
  chargingSchedule?: IncomingChargingSchedule[];
};

type IncomingChargingSchedule = {
  startSchedule?: string;
  chargingRateUnit: string;
  chargingSchedulePeriod?: IncomingChargingSchedulePeriod[];
};

type IncomingChargingSchedulePeriod = {
  startPeriod: number;
  limit?: unknown;
  numberPhases?: number;
  [key: string]: unknown;
};

type ClearCriteria = NonNullable<
  ClearChargingProfileRequestV201["chargingProfileCriteria"]
>;
type GetCriteria = GetChargingProfilesRequestV201["chargingProfile"];

function purposeToDomain(purpose: string): ChargingProfilePurposeType | null {
  switch (purpose) {
    case "ChargingStationMaxProfile":
      return ChargingProfilePurposeType.ChargePointMaxProfile;
    case "TxDefaultProfile":
      return ChargingProfilePurposeType.TxDefaultProfile;
    case "TxProfile":
      return ChargingProfilePurposeType.TxProfile;
    default:
      return null;
  }
}

function kindToDomain(kind: string): ChargingProfileKindType | null {
  switch (kind) {
    case "Absolute":
      return ChargingProfileKindType.Absolute;
    case "Recurring":
      return ChargingProfileKindType.Recurring;
    case "Relative":
      return ChargingProfileKindType.Relative;
    default:
      return null;
  }
}

function purposeToV201(
  purpose: ChargingProfilePurposeType,
): ReportChargingProfileType["chargingProfilePurpose"] {
  switch (purpose) {
    case ChargingProfilePurposeType.ChargePointMaxProfile:
      return "ChargingStationMaxProfile";
    case ChargingProfilePurposeType.TxDefaultProfile:
      return "TxDefaultProfile";
    case ChargingProfilePurposeType.TxProfile:
      return "TxProfile";
  }
}

function rateUnitToDomain(unit: string): ChargingRateUnitType | null {
  switch (unit) {
    case "W":
      return ChargingRateUnitType.W;
    case "A":
      return ChargingRateUnitType.A;
    default:
      return null;
  }
}

function recurrencyToDomain(
  recurrencyKind: string | undefined,
): RecurrencyKindType | null | undefined {
  switch (recurrencyKind) {
    case undefined:
      return undefined;
    case "Daily":
      return RecurrencyKindType.Daily;
    case "Weekly":
      return RecurrencyKindType.Weekly;
    default:
      return null;
  }
}

function isDomainRepresentablePeriod(period: unknown): boolean {
  if (period === null || typeof period !== "object") return false;
  const candidate = period as IncomingChargingSchedulePeriod;
  if (typeof candidate.limit !== "number") return false;
  return Object.keys(candidate).every((key) =>
    REPRESENTABLE_PERIOD_KEYS.has(key),
  );
}

function v201ProfileToDomain(
  chargingProfile: IncomingChargingProfile,
  evseId: number,
): ActiveChargingProfile | null {
  const purpose = purposeToDomain(chargingProfile.chargingProfilePurpose);
  const kind = kindToDomain(chargingProfile.chargingProfileKind);
  if (!purpose || !kind) return null;

  const recurrencyKind = recurrencyToDomain(chargingProfile.recurrencyKind);
  if (recurrencyKind === null) return null;
  if (kind === ChargingProfileKindType.Recurring && !recurrencyKind) {
    return null;
  }

  const schedule = chargingProfile.chargingSchedule?.[0];
  if (!schedule) return null;

  const rateUnit = rateUnitToDomain(schedule.chargingRateUnit);
  if (!rateUnit) return null;

  const periods = schedule.chargingSchedulePeriod;
  if (!periods || periods.length === 0) return null;
  if (!periods.every(isDomainRepresentablePeriod)) return null;

  return {
    chargingProfileId: chargingProfile.id,
    connectorId: evseId,
    stackLevel: chargingProfile.stackLevel,
    chargingProfilePurpose: purpose,
    chargingProfileKind: kind,
    chargingRateUnit: rateUnit,
    recurrencyKind,
    validFrom: chargingProfile.validFrom ?? schedule.startSchedule,
    validTo: chargingProfile.validTo,
    chargingSchedulePeriods: periods.map((period) => ({
      startPeriod: period.startPeriod,
      limit: period.limit as number,
      numberPhases: period.numberPhases,
    })),
  };
}

function domainProfileToV201(
  profile: ActiveChargingProfile,
): ReportChargingProfileType {
  return {
    id: profile.chargingProfileId,
    stackLevel: profile.stackLevel,
    chargingProfilePurpose: purposeToV201(profile.chargingProfilePurpose),
    chargingProfileKind: profile.chargingProfileKind,
    recurrencyKind: profile.recurrencyKind,
    validFrom: profile.validFrom,
    validTo: profile.validTo,
    chargingSchedule: [
      {
        id: profile.chargingProfileId,
        startSchedule: profile.validFrom,
        chargingRateUnit: profile.chargingRateUnit,
        chargingSchedulePeriod:
          profile.chargingSchedulePeriods as ReportChargingProfileType["chargingSchedule"][number]["chargingSchedulePeriod"],
      },
    ],
  };
}

function wattsToUnit(watts: number, unit: ChargingRateUnitType): number {
  if (unit === ChargingRateUnitType.W) return watts;
  return watts / REFERENCE_PHASE_VOLTAGE / DEFAULT_PHASES;
}

function affectedConnectors(
  ctx: V201InboundContext,
  evseId: number | undefined,
): Connector[] {
  if (evseId === undefined || evseId === 0) {
    return [...ctx.chargePoint.connectors.values()];
  }
  const connector = ctx.chargePoint.getConnector(evseId);
  return connector ? [connector] : [];
}

function applyProfileStatusV201(
  ctx: V201InboundContext,
  evseId: number | undefined,
): void {
  for (const connector of affectedConnectors(ctx, evseId)) {
    if (!connector.transaction) continue;
    const watts = connector.currentScheduleLimitWatts();
    if (watts === 0 && connector.status === OCPPStatus.Charging) {
      ctx.chargePoint.updateConnectorStatus(
        connector.id,
        OCPPStatus.SuspendedEVSE,
      );
    } else if (watts > 0 && connector.status === OCPPStatus.SuspendedEVSE) {
      ctx.chargePoint.updateConnectorStatus(connector.id, OCPPStatus.Charging);
    }
  }
}

function isCoherentProfileTarget(
  profile: ActiveChargingProfile,
  evseId: number,
): boolean {
  if (
    profile.chargingProfilePurpose === ChargingProfilePurposeType.TxProfile &&
    evseId === 0
  ) {
    return false;
  }
  if (
    profile.chargingProfilePurpose ===
      ChargingProfilePurposeType.ChargePointMaxProfile &&
    evseId !== 0
  ) {
    return false;
  }
  return true;
}

export function handleSetChargingProfileV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  const req = payload as SetChargingProfileRequestV201;
  const domain = v201ProfileToDomain(
    req.chargingProfile as unknown as IncomingChargingProfile,
    req.evseId,
  );
  if (!domain || !isCoherentProfileTarget(domain, req.evseId)) {
    return {
      response: { status: "Rejected" } satisfies SetChargingProfileResponseV201,
    };
  }

  if (req.evseId === 0) {
    ctx.chargePoint.stationProfiles.add(domain);
  } else {
    const connector = ctx.chargePoint.getConnector(req.evseId);
    if (!connector) {
      return {
        response: {
          status: "Rejected",
        } satisfies SetChargingProfileResponseV201,
      };
    }
    connector.addChargingProfile(domain);
  }

  return {
    response: { status: "Accepted" } satisfies SetChargingProfileResponseV201,
    afterResult: () => applyProfileStatusV201(ctx, req.evseId),
  };
}

function mapClearPurpose(
  criteria: ClearCriteria | undefined,
): ChargingProfilePurposeType | null | undefined {
  const purpose = criteria?.chargingProfilePurpose;
  if (purpose === undefined) return undefined;
  return purposeToDomain(purpose);
}

export function handleClearChargingProfileV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  const req = payload as ClearChargingProfileRequestV201;
  const criteria = req.chargingProfileCriteria;
  const purpose = mapClearPurpose(criteria);
  if (purpose === null) {
    return {
      response: {
        status: "Unknown",
      } satisfies ClearChargingProfileResponseV201,
    };
  }

  const removeCriteria = {
    profileId: req.chargingProfileId,
    purpose,
    stackLevel: criteria?.stackLevel,
  };
  const evseId = criteria?.evseId;
  let removed = 0;

  if (evseId === undefined || evseId === 0) {
    removed += ctx.chargePoint.stationProfiles.remove(removeCriteria);
  }

  if (evseId === undefined) {
    for (const connector of ctx.chargePoint.connectors.values()) {
      removed += connector.removeChargingProfiles(removeCriteria);
    }
  } else if (evseId > 0) {
    const connector = ctx.chargePoint.getConnector(evseId);
    if (connector) {
      removed += connector.removeChargingProfiles(removeCriteria);
    }
  }

  if (removed === 0) {
    return {
      response: {
        status: "Unknown",
      } satisfies ClearChargingProfileResponseV201,
    };
  }

  return {
    response: {
      status: "Accepted",
    } satisfies ClearChargingProfileResponseV201,
    afterResult: () => applyProfileStatusV201(ctx, evseId),
  };
}

function matchesGetCriteria(
  profile: ActiveChargingProfile,
  criteria: GetCriteria,
): boolean {
  if (criteria.chargingProfilePurpose !== undefined) {
    const purpose = purposeToDomain(criteria.chargingProfilePurpose);
    if (!purpose || profile.chargingProfilePurpose !== purpose) return false;
  }
  if (
    criteria.stackLevel !== undefined &&
    profile.stackLevel !== criteria.stackLevel
  ) {
    return false;
  }
  if (
    criteria.chargingProfileId !== undefined &&
    !criteria.chargingProfileId.includes(profile.chargingProfileId)
  ) {
    return false;
  }
  return true;
}

function getCandidateProfiles(
  ctx: V201InboundContext,
  evseId: number | undefined,
): ActiveChargingProfile[] {
  const profiles = [...ctx.chargePoint.stationProfiles.all()];
  if (evseId === undefined) {
    for (const connector of ctx.chargePoint.connectors.values()) {
      profiles.push(...connector.chargingProfiles);
    }
  } else if (evseId > 0) {
    const connector = ctx.chargePoint.getConnector(evseId);
    if (connector) {
      profiles.push(...connector.chargingProfiles);
    }
  }
  return profiles;
}

function groupByConnectorId(
  profiles: ActiveChargingProfile[],
): Map<number, ActiveChargingProfile[]> {
  const groups = new Map<number, ActiveChargingProfile[]>();
  for (const profile of profiles) {
    const group = groups.get(profile.connectorId);
    if (group) {
      group.push(profile);
    } else {
      groups.set(profile.connectorId, [profile]);
    }
  }
  return groups;
}

export function handleGetChargingProfilesV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  const req = payload as GetChargingProfilesRequestV201;
  const criteria = req.chargingProfile;
  if (
    criteria.chargingLimitSource !== undefined &&
    !criteria.chargingLimitSource.includes(REPORT_SOURCE)
  ) {
    return {
      response: {
        status: "NoProfiles",
      } satisfies GetChargingProfilesResponseV201,
    };
  }

  const matches = getCandidateProfiles(ctx, req.evseId).filter((profile) =>
    matchesGetCriteria(profile, criteria),
  );
  if (matches.length === 0) {
    return {
      response: {
        status: "NoProfiles",
      } satisfies GetChargingProfilesResponseV201,
    };
  }

  return {
    response: {
      status: "Accepted",
    } satisfies GetChargingProfilesResponseV201,
    afterResult: () => {
      for (const [evseId, profiles] of groupByConnectorId(matches)) {
        const chargingProfile = profiles.map(domainProfileToV201) as [
          ReportChargingProfileType,
          ...ReportChargingProfileType[],
        ];
        ctx.sendCall("ReportChargingProfiles", {
          requestId: req.requestId,
          chargingLimitSource: REPORT_SOURCE,
          evseId,
          chargingProfile,
        } satisfies ReportChargingProfilesRequestV201);
      }
    },
  };
}

export function handleGetCompositeScheduleV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  const req = payload as GetCompositeScheduleRequestV201;
  const anchor = new Date();
  let txProfile: ActiveChargingProfile | null = null;

  if (req.evseId > 0) {
    const connector = ctx.chargePoint.getConnector(req.evseId);
    if (!connector) {
      return {
        response: {
          status: "Rejected",
        } satisfies GetCompositeScheduleResponseV201,
      };
    }
    txProfile = connector.getActiveChargingProfile(anchor);
  }

  const chargePointMaxProfile =
    ctx.chargePoint.getActiveChargePointMaxProfile(anchor);
  const unit = (req.chargingRateUnit ?? ChargingRateUnitType.W) as
    ChargingRateUnitType.W | ChargingRateUnitType.A;
  const finitePeriods = buildCompositeWattsSchedule(
    { txProfile, chargePointMaxProfile },
    anchor,
    req.duration,
  )
    .filter((period) => Number.isFinite(period.watts))
    .map((period) => ({
      startPeriod: period.startPeriod,
      limit: wattsToUnit(period.watts, unit),
    }));

  if (finitePeriods.length === 0) {
    return {
      response: {
        status: "Accepted",
      } satisfies GetCompositeScheduleResponseV201,
    };
  }

  return {
    response: {
      status: "Accepted",
      schedule: {
        evseId: req.evseId,
        duration: req.duration,
        scheduleStart: anchor.toISOString(),
        chargingRateUnit: unit,
        chargingSchedulePeriod: finitePeriods as NonNullable<
          GetCompositeScheduleResponseV201["schedule"]
        >["chargingSchedulePeriod"],
      },
    } satisfies GetCompositeScheduleResponseV201,
  };
}
