import type { EVSettings } from "./EVSettings";
import type { Transaction } from "./Transaction";

/**
 * What the driver wants out of one charging session (#327). A target is
 * intent, not a car property, so it lives with the session; the connector's
 * EV settings only supply the default a new session copies.
 *
 * Protocol-agnostic like `OperatingPoint.ts`: no transport or `ocpp/` import.
 */
export interface SessionIntent {
  /** Opening SoC in percent, `undefined` when nothing names one. */
  initialSoc: number | undefined;
  /** SoC at which the session is done, `undefined` when nothing names one. */
  targetSoc: number | undefined;
  /** Stop the session once {@link targetSoc} is reached
   *  (`autoConfig.stopAtTargetSoc`). */
  stopAtTarget: boolean;
  /** Requested energy in Wh, an alternative to {@link targetSoc}. Reserved:
   *  nothing reads it yet. */
  requestedWh?: number;
  /** Epoch ms the driver leaves. Reserved: nothing reads it yet. */
  departureAt?: number;
}

/**
 * The one place a session's opening and target SoC are decided: the
 * transaction's own value, else the connector's EV-settings default. Every
 * derivation (the SoC from the register, its inverse, the curve's opening
 * SoC, the auto-stop) reads this, so they cannot disagree about the session.
 */
export function resolveSessionIntent(
  transaction: Pick<Transaction, "initialSoc" | "targetSoc"> | null | undefined,
  settings: Partial<Pick<EVSettings, "initialSoc" | "targetSoc">> | undefined,
  stopAtTarget = false,
): SessionIntent {
  return {
    initialSoc: transaction?.initialSoc ?? settings?.initialSoc,
    targetSoc: transaction?.targetSoc ?? settings?.targetSoc,
    stopAtTarget,
  };
}
