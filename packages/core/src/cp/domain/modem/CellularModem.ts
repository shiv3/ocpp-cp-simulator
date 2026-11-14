import type { ModemRepository } from "../persistence/ModemRepository";

/**
 * Stateful cellular modem and inserted SIM card (#928).
 *
 * Owned by a charge point, independent of the OCPP transport and of the
 * network fault-injection rules: the model says what is physically there
 * (modem, card, subscription state) and never says whether the link works —
 * that is resolved separately (#930).
 *
 * One modem with one SIM slot; no multi-SIM and no eSIM profile switching.
 */

/** The path the station reaches its CSMS over. Only `cellular` depends on the SIM. */
export type NetworkInterface = "ethernet" | "wifi" | "cellular";
export const NETWORK_INTERFACES: readonly NetworkInterface[] = [
  "ethernet",
  "wifi",
  "cellular",
];

/** A removed card is "no card", never a suspended one. */
export type SubscriptionState = "active" | "suspended";

/** Longest ICCID / IMSI OCPP can carry (BootNotification `maxLength: 20`). */
export const SIM_IDENTIFIER_MAX_LENGTH = 20;
export const OPERATOR_MAX_LENGTH = 64;
const LABEL = /^[\x21-\x7e][\x20-\x7e]*$/;

export interface SimCard {
  /** Simulator-owned identity; stable for the card's life, unique per insertion. */
  readonly simId: string;
  readonly iccid?: string;
  readonly imsi?: string;
  readonly operator?: string;
  readonly subscription: SubscriptionState;
}

/** What a caller supplies to insert or replace a card. */
export interface SimCardInit {
  readonly iccid?: string;
  readonly imsi?: string;
  readonly operator?: string;
  /** Default `active`. */
  readonly subscription?: SubscriptionState;
}

/**
 * What the BootNotification reports of the installed SIM (#929). Independent
 * of the subscription state: a suspended card still has identifiers.
 */
export type SimReportingPolicy = "none" | "iccid" | "iccid-and-imsi";
export const SIM_REPORTING_POLICIES: readonly SimReportingPolicy[] = [
  "none",
  "iccid",
  "iccid-and-imsi",
];
/** Default when a modem model is configured: report what the card carries. */
export const DEFAULT_SIM_REPORTING: SimReportingPolicy = "iccid-and-imsi";

/** Initial modem configuration (`modem` in the charge point's init). */
export interface ModemConfig {
  /** Default `true`. `false`: the station has no cellular modem at all. */
  readonly present?: boolean;
  /** Default `ethernet`: a SIM never disconnects a station on its own. */
  readonly networkInterface?: NetworkInterface;
  /** The card in the slot at start; absent or `null`: an empty slot. */
  readonly sim?: SimCardInit | null;
  /** What the BootNotification reports of the card (#929). Default `iccid-and-imsi`. */
  readonly reporting?: SimReportingPolicy;
}

/**
 * The distinct situations (#928). A station without a modem model at all
 * (the legacy default) has no {@link CellularModem}; it is not one of them.
 */
export type ModemSlotState = "no_modem" | "empty" | "inserted";

export interface ModemSnapshot {
  readonly slot: ModemSlotState;
  readonly reporting: SimReportingPolicy;
  readonly networkInterface: NetworkInterface;
  readonly sim: SimCard | null;
}

export type ModemErrorCode =
  | "modem_absent"
  | "slot_occupied"
  | "slot_empty"
  | "already_suspended"
  | "already_active"
  | "invalid_sim"
  | "invalid_network_interface"
  | "invalid_reporting_policy";

/** A refused modem command; the state is left as it was. */
export class ModemError extends Error {
  constructor(
    readonly code: ModemErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModemError";
  }
}

export type ModemChange =
  | { kind: "sim_inserted"; sim: SimCard }
  | { kind: "sim_removed"; sim: SimCard }
  | { kind: "sim_replaced"; previous: SimCard; sim: SimCard }
  | { kind: "subscription_suspended"; sim: SimCard }
  | { kind: "subscription_activated"; sim: SimCard }
  | { kind: "network_interface_changed"; networkInterface: NetworkInterface }
  | { kind: "reporting_policy_changed"; reporting: SimReportingPolicy };

/**
 * ICCID / IMSI are subscriber identifiers; deployments may regulate them. Every
 * read surface (status, RPC, MCP, logs) shows this form: only the last four
 * characters survive. The full value leaves the simulator in one place, the
 * BootNotification that the reporting policy allows (#929).
 */
export function maskSimIdentifier(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (value.length <= 4) return "*".repeat(value.length);
  return "*".repeat(value.length - 4) + value.slice(-4);
}

/** A card as read surfaces show it: identifiers masked, nothing else hidden. */
export interface RedactedSimCard {
  readonly simId: string;
  readonly iccid: string | null;
  readonly imsi: string | null;
  readonly operator: string | null;
  readonly subscription: SubscriptionState;
}

export function redactSimCard(sim: SimCard): RedactedSimCard {
  return {
    simId: sim.simId,
    iccid: maskSimIdentifier(sim.iccid),
    imsi: maskSimIdentifier(sim.imsi),
    operator: sim.operator ?? null,
    subscription: sim.subscription,
  };
}

export interface RedactedModemState {
  readonly slot: ModemSlotState;
  readonly reporting: SimReportingPolicy;
  readonly networkInterface: NetworkInterface;
  readonly sim: RedactedSimCard | null;
}

interface PersistedModem {
  readonly v: 1;
  readonly present: boolean;
  readonly networkInterface: NetworkInterface;
  readonly sim: SimCard | null;
  /** Absent in a document written before #929: the default applies. */
  readonly reporting?: SimReportingPolicy;
  /** Cards made so far: the next `simId` suffix, kept across a restart. */
  readonly seq: number;
}

function isReporting(value: unknown): value is SimReportingPolicy {
  return (
    typeof value === "string" &&
    (SIM_REPORTING_POLICIES as readonly string[]).includes(value)
  );
}

function isInterface(value: unknown): value is NetworkInterface {
  return (
    typeof value === "string" &&
    (NETWORK_INTERFACES as readonly string[]).includes(value)
  );
}

/** Why `init` is not a usable card, or `null`. Shared by config and RPC checks. */
export function simCardInitProblem(init: unknown): string | null {
  if (typeof init !== "object" || init === null || Array.isArray(init)) {
    return "sim must be an object";
  }
  const sim = init as Record<string, unknown>;
  for (const key of Object.keys(sim)) {
    if (!["iccid", "imsi", "operator", "subscription"].includes(key)) {
      return `sim.${key}: unknown field`;
    }
  }
  for (const key of ["iccid", "imsi"] as const) {
    const value = sim[key];
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > SIM_IDENTIFIER_MAX_LENGTH ||
      !/^[\x21-\x7e]+$/.test(value)
    ) {
      return `sim.${key} must be 1-${SIM_IDENTIFIER_MAX_LENGTH} printable characters without spaces`;
    }
  }
  const operator = sim.operator;
  if (
    operator !== undefined &&
    (typeof operator !== "string" ||
      operator.length > OPERATOR_MAX_LENGTH ||
      !LABEL.test(operator))
  ) {
    return `sim.operator must be 1-${OPERATOR_MAX_LENGTH} printable characters`;
  }
  const subscription = sim.subscription;
  if (
    subscription !== undefined &&
    subscription !== "active" &&
    subscription !== "suspended"
  ) {
    return "sim.subscription must be active or suspended";
  }
  return null;
}

/** Why `config` is not a usable modem configuration, or `null`. */
export function modemConfigProblem(config: unknown): string | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return "modem must be an object";
  }
  const c = config as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!["present", "networkInterface", "sim", "reporting"].includes(key)) {
      return `modem.${key}: unknown field`;
    }
  }
  if (c.present !== undefined && typeof c.present !== "boolean") {
    return "modem.present must be a boolean";
  }
  if (c.networkInterface !== undefined && !isInterface(c.networkInterface)) {
    return "modem.networkInterface must be ethernet, wifi or cellular";
  }
  if (c.reporting !== undefined && !isReporting(c.reporting)) {
    return "modem.reporting must be none, iccid or iccid-and-imsi";
  }
  if (c.sim !== undefined && c.sim !== null) {
    const problem = simCardInitProblem(c.sim);
    if (problem) return problem;
    if (c.present === false) return "modem.sim needs a modem (present: true)";
  }
  return null;
}

/**
 * The modem state machine. State is in memory; with a database every
 * change is also written through the {@link ModemRepository}, and a later
 * construction for the same charge point reads it back, so a restart keeps the
 * card, its subscription state and the selected interface. Without a database
 * (`:memory:` daemon, tests) a restart starts from the configured initial
 * state.
 */
export class CellularModem {
  private _present: boolean;
  private _interface: NetworkInterface;
  private _reporting: SimReportingPolicy;
  private _sim: SimCard | null;
  private _seq: number;
  private readonly _listeners = new Set<(change: ModemChange) => void>();

  /**
   * @param config initial state; used only when nothing is persisted for
   *   `cpId`. Persisted state wins: a station whose card was swapped at run
   *   time must not get the configured card back on restart.
   */
  constructor(
    private readonly _cpId: string,
    config: ModemConfig,
    private readonly _repository: ModemRepository,
  ) {
    const problem = modemConfigProblem(config);
    if (problem) throw new ModemError("invalid_sim", problem);
    this._present = config.present ?? true;
    this._interface = config.networkInterface ?? "ethernet";
    this._reporting = config.reporting ?? DEFAULT_SIM_REPORTING;
    this._seq = 0;
    this._sim = null;
    const stored = this.load();
    if (stored) {
      this._present = stored.present;
      this._interface = stored.networkInterface;
      this._reporting = stored.reporting ?? DEFAULT_SIM_REPORTING;
      this._sim = stored.sim;
      this._seq = stored.seq;
    } else {
      if (config.sim) this._sim = this.makeCard(config.sim);
      this.persist();
    }
  }

  get slot(): ModemSlotState {
    if (!this._present) return "no_modem";
    return this._sim ? "inserted" : "empty";
  }

  get networkInterface(): NetworkInterface {
    return this._interface;
  }

  get reporting(): SimReportingPolicy {
    return this._reporting;
  }

  /** The card in the slot, or `null`. */
  get sim(): SimCard | null {
    return this._sim;
  }

  snapshot(): ModemSnapshot {
    return {
      slot: this.slot,
      reporting: this._reporting,
      networkInterface: this._interface,
      sim: this._sim,
    };
  }

  /** Identifiers masked: what status, RPC and MCP return. */
  redacted(): RedactedModemState {
    return {
      slot: this.slot,
      reporting: this._reporting,
      networkInterface: this._interface,
      sim: this._sim ? redactSimCard(this._sim) : null,
    };
  }

  onChange(listener: (change: ModemChange) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  insertSim(init: SimCardInit): SimCard {
    this.requireModem();
    if (this._sim) {
      throw new ModemError("slot_occupied", "The SIM slot is occupied");
    }
    const sim = this.makeCard(init);
    this._sim = sim;
    this.commit({ kind: "sim_inserted", sim });
    return sim;
  }

  removeSim(): SimCard {
    const sim = this.requireSim();
    this._sim = null;
    this.commit({ kind: "sim_removed", sim });
    return sim;
  }

  /** Swap the card for a new one (new `simId`); the slot must be occupied. */
  replaceSim(init: SimCardInit): SimCard {
    const previous = this.requireSim();
    const sim = this.makeCard(init);
    this._sim = sim;
    this.commit({ kind: "sim_replaced", previous, sim });
    return sim;
  }

  /** The card stays in the slot with the same identifiers. */
  suspendSubscription(): SimCard {
    const current = this.requireSim();
    if (current.subscription === "suspended") {
      throw new ModemError(
        "already_suspended",
        "The subscription is already suspended",
      );
    }
    const sim = { ...current, subscription: "suspended" as const };
    this._sim = sim;
    this.commit({ kind: "subscription_suspended", sim });
    return sim;
  }

  activateSubscription(): SimCard {
    const current = this.requireSim();
    if (current.subscription === "active") {
      throw new ModemError(
        "already_active",
        "The subscription is already active",
      );
    }
    const sim = { ...current, subscription: "active" as const };
    this._sim = sim;
    this.commit({ kind: "subscription_activated", sim });
    return sim;
  }

  setNetworkInterface(networkInterface: NetworkInterface): void {
    if (!isInterface(networkInterface)) {
      throw new ModemError(
        "invalid_network_interface",
        "networkInterface must be ethernet, wifi or cellular",
      );
    }
    if (networkInterface === this._interface) return;
    this._interface = networkInterface;
    this.commit({ kind: "network_interface_changed", networkInterface });
  }

  /** What the BootNotification reports of the card; see {@link projectBootIdentifiers}. */
  setReportingPolicy(reporting: SimReportingPolicy): void {
    if (!isReporting(reporting)) {
      throw new ModemError(
        "invalid_reporting_policy",
        "reporting must be none, iccid or iccid-and-imsi",
      );
    }
    if (reporting === this._reporting) return;
    this._reporting = reporting;
    this.commit({ kind: "reporting_policy_changed", reporting });
  }

  private requireModem(): void {
    if (!this._present) {
      throw new ModemError("modem_absent", "The station has no cellular modem");
    }
  }

  private requireSim(): SimCard {
    this.requireModem();
    if (!this._sim) {
      throw new ModemError("slot_empty", "The SIM slot is empty");
    }
    return this._sim;
  }

  private makeCard(init: SimCardInit): SimCard {
    const problem = simCardInitProblem(init);
    if (problem) throw new ModemError("invalid_sim", problem);
    this._seq += 1;
    return {
      simId: `${this._cpId}-sim-${this._seq}`,
      ...(init.iccid !== undefined ? { iccid: init.iccid } : {}),
      ...(init.imsi !== undefined ? { imsi: init.imsi } : {}),
      ...(init.operator !== undefined ? { operator: init.operator } : {}),
      subscription: init.subscription ?? "active",
    };
  }

  private commit(change: ModemChange): void {
    this.persist();
    for (const listener of [...this._listeners]) listener(change);
  }

  private load(): PersistedModem | null {
    try {
      const document = this._repository.load();
      if (document === null) return null;
      const parsed = JSON.parse(document) as Partial<PersistedModem>;
      if (
        parsed.v !== 1 ||
        typeof parsed.present !== "boolean" ||
        !isInterface(parsed.networkInterface) ||
        typeof parsed.seq !== "number"
      ) {
        return null;
      }
      const sim = parsed.sim ?? null;
      if (
        sim !== null &&
        (typeof sim.simId !== "string" ||
          (sim.subscription !== "active" && sim.subscription !== "suspended"))
      ) {
        return null;
      }
      return { ...(parsed as PersistedModem), sim };
    } catch {
      // A corrupt row is treated as absent, like the other kv-backed stores.
      return null;
    }
  }

  private persist(): void {
    const value: PersistedModem = {
      v: 1,
      present: this._present,
      networkInterface: this._interface,
      reporting: this._reporting,
      sim: this._sim,
      seq: this._seq,
    };
    try {
      this._repository.save(JSON.stringify(value));
    } catch {
      // Persistence is best-effort: the in-memory state stays authoritative.
    }
  }

  /**
   * A modem rebuilt from the persisted document, or `null` when none (or an
   * unreadable one) is stored: a restart without the initial `modem` config
   * still brings a persisted modem back.
   */
  static restore(
    cpId: string,
    repository: ModemRepository,
  ): CellularModem | null {
    try {
      const document = repository.load();
      if (document === null) return null;
      if ((JSON.parse(document) as { v?: unknown }).v !== 1) return null;
    } catch {
      return null;
    }
    return new CellularModem(cpId, {}, repository);
  }
}
