import {
  PowerStateError,
  type ChargePoint,
  type PowerLossOptions,
  type PowerRestoreOptions,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";

/** What the power helpers need from LocalChargePointService. */
export interface LocalPowerHost {
  readonly chargePoints: ReadonlyMap<string, ChargePoint>;
}

export async function powerLoss(
  host: LocalPowerHost,
  cpId: string,
  options?: PowerLossOptions,
): Promise<{ ok: true; transactions: number } | { ok: false; error: string }> {
  const cp = host.chargePoints.get(cpId);
  if (!cp) return { ok: false, error: "cp_not_found" };
  try {
    return {
      ok: true,
      transactions: cp.powerLoss(options).transactions.length,
    };
  } catch (err) {
    if (err instanceof PowerStateError) return { ok: false, error: err.code };
    throw err;
  }
}

export async function powerRestore(
  host: LocalPowerHost,
  cpId: string,
  options?: PowerRestoreOptions,
) {
  const cp = host.chargePoints.get(cpId);
  if (!cp) return { ok: false as const, error: "cp_not_found" };
  try {
    return { ok: true as const, ...cp.restorePower(options) };
  } catch (err) {
    if (err instanceof PowerStateError) {
      return { ok: false as const, error: err.code };
    }
    throw err;
  }
}
