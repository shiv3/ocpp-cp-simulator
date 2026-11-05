import type { ChargingSession } from "../cp/domain/session/ChargingSession";

/** Test fixture (#447): a completed OCPP 1.6 session on CP-1 connector 1 —
 *  25 m 30 s, 12 345 Wh, stopped Local — with `overrides` applied. Plain TS,
 *  shared by the bun and vitest suites. */
export function chargingSession(
  overrides: Partial<ChargingSession> = {},
): ChargingSession {
  return {
    sessionId: "s-1",
    cpId: "CP-1",
    connectorId: 1,
    evseId: null,
    ocppVersion: "OCPP-1.6J",
    transactionId: "42",
    idTag: "TAG-1",
    startedAt: "2026-10-28T10:00:00.000Z",
    endedAt: "2026-10-28T10:25:30.000Z",
    durationMs: 1_530_000,
    meterStartWh: 1000,
    meterStopWh: 13_345,
    energyWh: 12_345,
    stopReason: "Local",
    triggerReason: null,
    authorizationStatus: null,
    outcome: "completed",
    ...overrides,
  };
}

/** The fields of a session still running: no end, no stop meter or reason. */
export const UNENDED = {
  endedAt: null,
  durationMs: null,
  meterStopWh: null,
  energyWh: null,
  stopReason: null,
  outcome: "active",
} as const satisfies Partial<ChargingSession>;

/** {@link chargingSession} still running. */
export function activeChargingSession(
  overrides: Partial<ChargingSession> = {},
): ChargingSession {
  return chargingSession({ ...UNENDED, ...overrides });
}
