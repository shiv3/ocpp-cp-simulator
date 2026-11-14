import type { ModemSnapshot, NetworkInterface } from "./CellularModem";

/**
 * Cellular link availability and SIM-scoped policies (#930).
 *
 * The modem model (#928) says what is physically there. This module decides,
 * from that and from the SIM-scoped policies, whether a station whose
 * **selected path is cellular** has service, and which throughput caps apply.
 * It is a pure function of its inputs: the charge point applies the result to
 * its transport, the daemon persists and pushes the policies.
 */

/** Why a cellular path is unavailable. Independent reasons can coexist. */
export type CellularOutageReason =
  /** The station has no modem at all. */
  | "modem_absent"
  /** Modem, but nothing in the slot. */
  | "sim_missing"
  /** A card is inserted but its subscription is suspended. */
  | "subscription_suspended"
  /** A SIM-scoped policy blocks the card's service. */
  | "sim_network_blocked";
// `no_coverage` (proposed in #930) is reserved: coverage is not simulated yet.

export type CellularServiceState = "online" | "blocked";

/** Exactly one selector per policy: the precedence stays unambiguous. */
export interface CellularPolicyMatch {
  /** The simulator's stable SIM identity (`<cpId>-sim-<n>`). */
  readonly simId?: string;
  /** The card's ICCID; matches stations that acquire the card later too. */
  readonly iccid?: string;
  /** The operator label of the card (a group of cards). */
  readonly operator?: string;
}

export interface CellularPolicy {
  readonly match: CellularPolicyMatch;
  /** `blocked` takes the service away; `online` (default) leaves it. */
  readonly service?: CellularServiceState;
  /** Sustained caps in payload bytes per second; absent: uncapped. */
  readonly upstreamBytesPerSecond?: number;
  readonly downstreamBytesPerSecond?: number;
  /** Default `true`. A disabled policy is kept but selects nothing. */
  readonly enabled?: boolean;
}

/** Policy id -> policy. Persisted by the daemon, pushed to every charge point. */
export type CellularPolicySet = Readonly<Record<string, CellularPolicy>>;

export type CellularPolicySelector = "simId" | "iccid" | "operator";

export interface MatchedCellularPolicy {
  readonly id: string;
  /** What the policy matched the card by (the selection source). */
  readonly by: CellularPolicySelector;
  readonly service: CellularServiceState;
}

export interface CellularLinkState {
  /** The station's selected path. `cellular` is the only one a SIM governs. */
  readonly networkInterface: NetworkInterface;
  /** Whether the OCPP link may be up. `true` unless the path is cellular and out of service. */
  readonly available: boolean;
  /** Empty when available. */
  readonly reasons: CellularOutageReason[];
  /**
   * Effective caps (the lowest matching one per direction), only while the
   * path is cellular; `null` otherwise or when uncapped.
   */
  readonly upstreamBytesPerSecond: number | null;
  readonly downstreamBytesPerSecond: number | null;
  /** The policies that select the installed card, in id order. */
  readonly policies: MatchedCellularPolicy[];
}

/** The link as read surfaces show it. `enforced` is false where the transport
 *  cannot be held down (an OCPP SOAP station): the state is reported only. */
export type CellularLinkWire = CellularLinkState & {
  readonly enforced: boolean;
};

export const CELLULAR_POLICY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_CELLULAR_POLICIES = 200;
export const MAX_BYTES_PER_SECOND = 1_000_000_000;

const POLICY_KEYS = [
  "match",
  "service",
  "upstreamBytesPerSecond",
  "downstreamBytesPerSecond",
  "enabled",
];
const MATCH_KEYS: readonly CellularPolicySelector[] = [
  "simId",
  "iccid",
  "operator",
];

/** Why `value` is not a usable policy set, or `null`. */
export function cellularPoliciesProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "policies must be an object of policy id -> policy";
  }
  const ids = Object.keys(value);
  if (ids.length > MAX_CELLULAR_POLICIES) {
    return `at most ${MAX_CELLULAR_POLICIES} policies`;
  }
  for (const id of ids) {
    if (!CELLULAR_POLICY_ID.test(id)) {
      return `policy id "${id}" must be 1-64 characters of letters, digits, . _ -`;
    }
    const policy = (value as Record<string, unknown>)[id];
    const where = `policies.${id}`;
    if (
      typeof policy !== "object" ||
      policy === null ||
      Array.isArray(policy)
    ) {
      return `${where} must be an object`;
    }
    const p = policy as Record<string, unknown>;
    for (const key of Object.keys(p)) {
      if (!POLICY_KEYS.includes(key)) return `${where}.${key}: unknown field`;
    }
    const match = p.match;
    if (typeof match !== "object" || match === null || Array.isArray(match)) {
      return `${where}.match must be an object`;
    }
    const matchKeys = Object.keys(match);
    for (const key of matchKeys) {
      if (!(MATCH_KEYS as readonly string[]).includes(key)) {
        return `${where}.match.${key}: unknown field`;
      }
    }
    if (matchKeys.length !== 1) {
      return `${where}.match needs exactly one of simId, iccid, operator`;
    }
    const selector = (match as Record<string, unknown>)[matchKeys[0]];
    if (
      typeof selector !== "string" ||
      selector.length < 1 ||
      selector.length > 64 ||
      !/^[\x21-\x7e][\x20-\x7e]*$/.test(selector)
    ) {
      return `${where}.match.${matchKeys[0]} must be 1-64 printable characters`;
    }
    if (
      p.service !== undefined &&
      p.service !== "online" &&
      p.service !== "blocked"
    ) {
      return `${where}.service must be online or blocked`;
    }
    for (const key of [
      "upstreamBytesPerSecond",
      "downstreamBytesPerSecond",
    ] as const) {
      const cap = p[key];
      if (cap === undefined) continue;
      if (
        typeof cap !== "number" ||
        !Number.isInteger(cap) ||
        cap < 1 ||
        cap > MAX_BYTES_PER_SECOND
      ) {
        return `${where}.${key} must be an integer of 1-${MAX_BYTES_PER_SECOND}`;
      }
    }
    if (p.enabled !== undefined && typeof p.enabled !== "boolean") {
      return `${where}.enabled must be a boolean`;
    }
  }
  return null;
}

/**
 * The policies that select the card in the slot. A policy applies by SIM
 * identity (`simId`), ICCID or operator label; there is no precedence between
 * selectors, because the effects combine in the restrictive direction only
 * (see {@link resolveCellularLink}).
 */
export function matchCellularPolicies(
  modem: ModemSnapshot | null,
  policies: CellularPolicySet,
): MatchedCellularPolicy[] {
  const sim = modem?.sim;
  if (!sim) return [];
  const matched: MatchedCellularPolicy[] = [];
  for (const id of Object.keys(policies).sort()) {
    const policy = policies[id];
    if (policy.enabled === false) continue;
    const { match } = policy;
    const by: CellularPolicySelector | null =
      match.simId !== undefined && match.simId === sim.simId
        ? "simId"
        : match.iccid !== undefined && match.iccid === sim.iccid
          ? "iccid"
          : match.operator !== undefined && match.operator === sim.operator
            ? "operator"
            : null;
    if (by) matched.push({ id, by, service: policy.service ?? "online" });
  }
  return matched;
}

/**
 * Resolve the cellular link of a station.
 *
 * - A station whose selected path is **not** cellular is always available:
 *   suspending or blocking its (unused) SIM changes nothing, and caps do not
 *   apply. There is no implicit multi-interface routing or failover.
 * - On a cellular path the link is available only with a modem, a card, an
 *   active subscription and no matching `blocked` policy. The reasons are
 *   independent and all reported.
 * - Policies only ever restrict: `blocked` beats `online` (an `online` policy
 *   can never reactivate a suspended subscription or undo another policy's
 *   block) and the lowest matching cap per direction wins. That makes the
 *   result independent of policy order and of the selector used.
 *
 * `modem === null` is a station without a modem model: nothing governs it.
 */
export function resolveCellularLink(
  modem: ModemSnapshot | null,
  policies: CellularPolicySet,
): CellularLinkState | null {
  if (!modem) return null;
  const matched = matchCellularPolicies(modem, policies);
  if (modem.networkInterface !== "cellular") {
    return {
      networkInterface: modem.networkInterface,
      available: true,
      reasons: [],
      upstreamBytesPerSecond: null,
      downstreamBytesPerSecond: null,
      policies: matched,
    };
  }
  const reasons: CellularOutageReason[] = [];
  if (modem.slot === "no_modem") reasons.push("modem_absent");
  else if (modem.slot === "empty") reasons.push("sim_missing");
  else if (modem.sim?.subscription === "suspended") {
    reasons.push("subscription_suspended");
  }
  if (matched.some((m) => m.service === "blocked")) {
    reasons.push("sim_network_blocked");
  }
  const cap = (key: "upstreamBytesPerSecond" | "downstreamBytesPerSecond") => {
    const caps = matched
      .map((m) => policies[m.id][key])
      .filter((v): v is number => v !== undefined);
    return caps.length > 0 ? Math.min(...caps) : null;
  };
  return {
    networkInterface: "cellular",
    available: reasons.length === 0,
    reasons,
    upstreamBytesPerSecond: cap("upstreamBytesPerSecond"),
    downstreamBytesPerSecond: cap("downstreamBytesPerSecond"),
    policies: matched,
  };
}

/** Whether two link states differ in anything the transport or an observer acts on. */
export function sameCellularLink(
  a: CellularLinkState | null,
  b: CellularLinkState | null,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
