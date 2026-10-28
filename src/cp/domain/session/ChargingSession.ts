/**
 * Charging-session history (#447): one normalized record per transaction the
 * simulator ran, whatever OCPP version carried it.
 *
 * OCPP 1.6 spreads a session over StartTransaction / MeterValues /
 * StopTransaction; 2.x over TransactionEvent Started / Updated / Ended. Both
 * map onto this one shape. It is a read model of what the charge point did,
 * not a CSMS transaction database: no tariff, no price, no billing state.
 *
 * Full model and outcome rules: `docs/concepts/charging-sessions.md`.
 */

export const CHARGING_SESSION_OUTCOMES = [
  "active",
  "completed",
  "interrupted",
  "failed",
] as const;

/**
 * - `active` — the transaction is still running.
 * - `completed` — it ended normally (Local, Remote, EV unplugged, limit
 *   reached, …).
 * - `interrupted` — it ended abnormally (reset, emergency stop, fault, unlock
 *   command, …) or was lost across a process restart.
 * - `failed` — the CSMS refused the start: a CALLERROR on StartTransaction,
 *   or an id it did not accept and the station stopped on.
 */
export type ChargingSessionOutcome = (typeof CHARGING_SESSION_OUTCOMES)[number];

export interface ChargingSession {
  /** Own key. Never the transaction id: 1.6's is 0 until the CSMS assigns
   *  it (and may never be), 2.x's is minted at the first TransactionEvent. */
  sessionId: string;
  cpId: string;
  connectorId: number;
  /** OCPP 2.x EVSE id; null for 1.x, which has no EVSE level. */
  evseId: number | null;
  ocppVersion: string;
  /** 1.6: the CSMS-assigned integer, as a string. 2.x: the station-minted
   *  id. Null until known. */
  transactionId: string | null;
  idTag: string | null;
  /** ISO 8601. */
  startedAt: string;
  /** ISO 8601; null while active, or when the end was never observed. */
  endedAt: string | null;
  durationMs: number | null;
  /** Energy register (Wh) at the start. */
  meterStartWh: number;
  /** Energy register (Wh) at the end; null when the end was never observed. */
  meterStopWh: number | null;
  energyWh: number | null;
  /** The stop reason as sent: 1.6 `reason`, 2.x `stoppedReason`. */
  stopReason: string | null;
  /** 2.x `triggerReason` of the Ended event; null for 1.x. */
  triggerReason: string | null;
  /** The last id status the CSMS answered other than `Accepted`, or null. */
  authorizationStatus: string | null;
  outcome: ChargingSessionOutcome;
}

/** `meterStop − meterStart`, or null when the end is unknown or the register
 *  went backwards. */
export function deriveEnergyWh(
  meterStartWh: number,
  meterStopWh: number | null,
): number | null {
  if (meterStopWh === null) return null;
  const energy = meterStopWh - meterStartWh;
  return energy >= 0 ? energy : null;
}

/** `endedAt − startedAt` in ms, or null when the end is unknown or earlier. */
export function deriveDurationMs(
  startedAt: string,
  endedAt: string | null,
): number | null {
  if (endedAt === null) return null;
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

/** Stop reasons, in both the 1.6 and the 2.x vocabularies, that end a
 *  session abnormally. */
const INTERRUPTING_REASONS: ReadonlySet<string> = new Set([
  "EmergencyStop",
  "HardReset",
  "SoftReset",
  "ImmediateReset",
  "Reboot",
  "PowerLoss",
  "UnlockCommand",
  "GroundFault",
  "OvercurrentFault",
  "PowerQuality",
  "Timeout",
]);

/**
 * The outcome of a session that ended through a stop.
 *
 * `reason` is the stop cause the domain recorded (the 2.x `stoppedReason`
 * when one was named, else the 1.6 `stopReason`), not the wire value: the
 * 2.x encoder folds `UnlockCommand` into `Other`, which would hide it.
 */
export function classifyEndedSession(input: {
  reason: string | undefined;
  authorizationStatus: string | null;
}): Exclude<ChargingSessionOutcome, "active"> {
  const { reason, authorizationStatus } = input;
  if (reason === "DeAuthorized") {
    return authorizationStatus !== null ? "failed" : "interrupted";
  }
  return reason !== undefined && INTERRUPTING_REASONS.has(reason)
    ? "interrupted"
    : "completed";
}
