import type { TransactionChargingState } from "./Transaction";

/**
 * The physical EV and cable side of a connector (#453).
 *
 * The OCPP connector status says what the station reports; this says what is
 * physically there. It is the cause the status reacts to, never a parallel
 * status: `ChargePoint.evPlugIn`, `evDisconnected` and `evSetReady` turn a
 * change of it into the status writes, transactions and wire messages the
 * protocol handlers already own.
 *
 * - `disconnected`: no cable, or the EV side was unplugged.
 * - `connected-ready`: a cable is plugged in and the EV asks for energy (the
 *   state right after a plug-in, and while a transaction charges).
 * - `connected-not-ready`: a cable is plugged in and the EV does not ask for
 *   energy (it paused or is full): the running transaction is `SuspendedEV`.
 */
export const EV_CONNECTION_STATES = [
  "disconnected",
  "connected-ready",
  "connected-not-ready",
] as const;

export type EvConnectionState = (typeof EV_CONNECTION_STATES)[number];

export function evConnectionOf(
  cableConnected: boolean,
  ready: boolean,
): EvConnectionState {
  if (!cableConnected) return "disconnected";
  return ready ? "connected-ready" : "connected-not-ready";
}

/**
 * The 2.x `chargingState` a transaction starting now reports in its Started
 * event (E02.FR.13: a Started event always carries one). No cable is `Idle`
 * ("no connection between EV and EVSE", ChargingStateEnumType): an idToken-
 * first start (E03) reports `EVConnected` at the plug-in that follows (#846).
 */
export function startChargingStateOf(
  state: EvConnectionState,
): TransactionChargingState {
  return state === "disconnected" ? "Idle" : "Charging";
}
