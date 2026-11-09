/**
 * How a station divides one power budget between its connectors (#608).
 *
 * The station term of the operating point resolution (#327): this module
 * only computes each connector's share, `resolveOperatingPoint` narrows the
 * connector's cap by it. Protocol-agnostic: no transport or `ocpp/` import,
 * and no clock; the share is a pure function of the configuration and of
 * which connectors have a running transaction, so it is recalculated on every
 * read and a transaction that starts or stops moves it at once.
 */

/** How the budget is divided. */
export const POWER_SHARING_STRATEGIES = ["equal", "active"] as const;
export type PowerSharingStrategy = (typeof POWER_SHARING_STRATEGIES)[number];

/**
 * A non-standard configuration key that carries the station's current limit
 * in amperes. `ChangeConfiguration` on it changes the limit (OCPP 1.6 §5.3
 * lets a station accept vendor-specific keys; an unknown key is `NotSupported`,
 * a declared one is `Accepted`).
 */
export interface StationCurrentLimit {
  /** The configuration key name. */
  readonly key: string;
  /** Limit in amperes before any ChangeConfiguration. */
  readonly valueA: number;
  /** Phase-to-neutral volts the limit is converted with; default 230. */
  readonly voltageV?: number;
  /** Phases the limit applies to; default 3. */
  readonly phases?: 1 | 3;
}

export interface PowerSharingConfig {
  /** The station's total power in watts. */
  readonly totalPowerW?: number;
  /** `equal` splits it between all connectors always; `active` between the
   *  connectors with a running transaction. Default `equal`. */
  readonly strategy?: PowerSharingStrategy;
  /** A current limit as the budget; the lower of this and `totalPowerW`
   *  applies when both are set. */
  readonly currentLimit?: StationCurrentLimit;
}

/** The budget in watts for a current limit value. */
export function currentLimitToWatts(
  limit: StationCurrentLimit,
  amps: number,
): number {
  return amps * (limit.voltageV ?? 230) * (limit.phases ?? 3);
}

/** The station budget in watts, `Infinity` when nothing is declared.
 *  `currentLimitA` is the live value of the declared key. */
export function stationBudgetW(
  config: PowerSharingConfig | undefined,
  currentLimitA: number | undefined,
): number {
  if (!config) return Infinity;
  const budgets = [Infinity];
  if (config.totalPowerW !== undefined) budgets.push(config.totalPowerW);
  if (config.currentLimit) {
    budgets.push(
      currentLimitToWatts(
        config.currentLimit,
        currentLimitA ?? config.currentLimit.valueA,
      ),
    );
  }
  return Math.min(...budgets);
}

export interface ShareParticipant {
  readonly connectorId: number;
  /** The connector's own hardware cap in watts, `Infinity` when none. */
  readonly capW: number;
  /** A transaction is running on the connector. */
  readonly active: boolean;
}

/**
 * The share of `connectorId` in watts. Water-filling: every connector in the
 * split gets an equal part of the budget, a part above a connector's own cap
 * is passed on to the others, so the shares add up to the budget whenever the
 * caps allow it. A connector outside the split (idle under `active`) gets the
 * share it would have if it joined, so a transaction that starts finds its
 * cap already there. `Infinity` when the station declares no budget.
 */
export function connectorShareW(
  budgetW: number,
  strategy: PowerSharingStrategy,
  participants: readonly ShareParticipant[],
  connectorId: number,
): number {
  if (!Number.isFinite(budgetW)) return Infinity;
  const self = participants.find((p) => p.connectorId === connectorId);
  if (!self) return budgetW;
  const group =
    strategy === "active"
      ? participants.filter((p) => p.active || p.connectorId === connectorId)
      : participants;
  const caps = group.map((p) => p.capW).sort((a, b) => a - b);
  let left = budgetW;
  let remaining = caps.length;
  let level = Infinity;
  for (const cap of caps) {
    const equalPart = left / remaining;
    if (cap >= equalPart) {
      level = equalPart;
      break;
    }
    left -= cap;
    remaining -= 1;
  }
  return Math.min(self.capW, level);
}

/** Why `value` is not a usable power sharing configuration, or `null`. */
export function powerSharingProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "powerSharing must be an object";
  }
  const { totalPowerW, strategy, currentLimit } = value as Record<
    string,
    unknown
  >;
  const positive = (v: unknown): boolean =>
    typeof v === "number" && Number.isFinite(v) && v > 0;
  if (totalPowerW !== undefined && !positive(totalPowerW)) {
    return "powerSharing.totalPowerW must be a positive number of watts";
  }
  if (
    strategy !== undefined &&
    !(POWER_SHARING_STRATEGIES as readonly unknown[]).includes(strategy)
  ) {
    return `powerSharing.strategy must be one of ${POWER_SHARING_STRATEGIES.join(", ")}`;
  }
  if (totalPowerW === undefined && currentLimit === undefined) {
    return "powerSharing needs totalPowerW or currentLimit";
  }
  if (currentLimit !== undefined) {
    if (typeof currentLimit !== "object" || currentLimit === null) {
      return "powerSharing.currentLimit must be an object";
    }
    const c = currentLimit as Record<string, unknown>;
    if (typeof c.key !== "string" || c.key.length === 0 || c.key.length > 50) {
      return "powerSharing.currentLimit.key must be a string of 1-50 characters";
    }
    if (!positive(c.valueA)) {
      return "powerSharing.currentLimit.valueA must be a positive number of amperes";
    }
    if (c.voltageV !== undefined && !positive(c.voltageV)) {
      return "powerSharing.currentLimit.voltageV must be positive";
    }
    if (c.phases !== undefined && c.phases !== 1 && c.phases !== 3) {
      return "powerSharing.currentLimit.phases must be 1 or 3";
    }
  }
  return null;
}

/** Why `value` is not a usable DC efficiency, or `null`. */
export function dcEfficiencyProblem(value: unknown): string | null {
  return typeof value === "number" && value > 0 && value <= 1
    ? null
    : "dcEfficiency must be a number above 0 and at most 1";
}
