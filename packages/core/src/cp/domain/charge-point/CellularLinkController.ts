import type { EventEmitter } from "../../shared/EventEmitter";
import { LogType, type Logger } from "../../shared/Logger";
import {
  type CellularModem,
  maskSimIdentifier,
  type ModemChange,
  type RedactedModemState,
  type SimCard,
} from "../modem/CellularModem";
import {
  resolveCellularLink,
  sameCellularLink,
  type CellularLinkState,
  type CellularLinkWire,
  type CellularPolicySet,
} from "../modem/cellularLink";
import type { ChargePointSocket } from "../transport/ChargePointSocket";
import type { ResolvedNetworkSimConfig } from "../transport/networkSim";
import type { ChargePointEvents } from "./ChargePointEvents";

/** What the cellular link controller needs from its charge point. */
export interface CellularLinkHost {
  readonly logger: Logger;
  readonly events: EventEmitter<ChargePointEvents>;
  /** Read through a function: the socket is assigned after the modem. */
  readonly webSocket: () => ChargePointSocket | null;
  readonly isSoapChargePoint: () => boolean;
  /** The public `connect()` of the charge point (spies must still see it). */
  readonly connect: () => void;
}

/**
 * The cellular modem, the SIM-scoped policies, the resolved link and the
 * network-sim summary of one charge point (#930). Owns that state; the
 * charge point keeps the public methods as thin delegates.
 */
export class CellularLinkController {
  private _modem: CellularModem | null = null;
  /** #930: the SIM-scoped policies the daemon pushed (empty: none). */
  private _cellularPolicies: CellularPolicySet = {};
  /** #930: the last resolved link; `null` without a modem model. */
  private _cellularLink: CellularLinkState | null = null;
  /** #930: an explicit connect() arrived while the link was down. */
  private _connectOnLinkRestore = false;
  private _networkSimSummary: {
    enabled: boolean;
    manualRuleIds: string[];
  } | null = null;

  constructor(private readonly host: CellularLinkHost) {}

  /** Install the modem and subscribe to its changes. */
  attachModem(modem: CellularModem | null): void {
    this._modem = modem;
    this._modem?.onChange((change) => {
      this.logModemChange(change);
      this.reevaluateCellularLink();
    });
  }

  get modem(): CellularModem | null {
    return this._modem;
  }

  get link(): CellularLinkState | null {
    return this._cellularLink;
  }

  /** #930: remember an explicit connect() that arrived while the link is down. */
  deferConnectUntilLinkRestored(): void {
    this._connectOnLinkRestore = true;
  }

  /** #930: forget a deferred connect (disconnect). */
  clearConnectOnLinkRestore(): void {
    this._connectOnLinkRestore = false;
  }

  /**
   * #930: install the SIM-scoped policies (the daemon pushes the whole set to
   * every charge point, also to one created later). The selection is dynamic:
   * it is recomputed against the card in the slot now and after every SIM
   * change, so a replaced card is governed by the policies that match the new
   * one. Ignored by a station without a modem model.
   */
  setCellularPolicies(policies: CellularPolicySet): void {
    this._cellularPolicies = policies;
    this.reevaluateCellularLink();
  }

  cellularLink(): CellularLinkState | null {
    return this._cellularLink;
  }

  /**
   * #930: the masked modem state with its resolved link, or `null` without a
   * modem model. `enforced` is false for a SOAP station: its transport is not
   * a socket the link gate can hold down.
   */
  modemState(): (RedactedModemState & { link: CellularLinkWire }) | null {
    if (!this._modem || !this._cellularLink) return null;
    return {
      ...this._modem.redacted(),
      link: { ...this._cellularLink, enforced: this.host.webSocket() !== null },
    };
  }

  /**
   * Resolve the cellular link and apply it: caps to the transport, the
   * availability gate to the socket. Idempotent; emits `cellularLinkChanged`
   * only when the result differs. The OCPP side is untouched: no boot, no
   * reset, power and transactions stay (#930, #702).
   */
  reevaluateCellularLink(): void {
    const modem = this._modem;
    const next = modem
      ? resolveCellularLink(modem.snapshot(), this._cellularPolicies)
      : null;
    const previous = this._cellularLink;
    if (sameCellularLink(previous, next)) return;
    this._cellularLink = next;
    if (!next) return;
    const webSocket = this.host.webSocket();
    webSocket?.setBandwidthLimits({
      upstreamBytesPerSecond: next.upstreamBytesPerSecond,
      downstreamBytesPerSecond: next.downstreamBytesPerSecond,
    });
    const wasAvailable = previous?.available ?? true;
    if (next.available !== wasAvailable) {
      this.host.logger.info(
        next.available
          ? "Cellular link restored"
          : `Cellular link unavailable: ${next.reasons.join(", ")}`,
        LogType.WEBSOCKET,
      );
      webSocket?.setLinkBlocked(next.available ? null : next.reasons.join(","));
      if (next.available && this._connectOnLinkRestore) {
        this._connectOnLinkRestore = false;
        if (webSocket && !webSocket.isOpenOrConnecting()) {
          this.host.connect();
        }
      }
    }
    if (
      next.available !== wasAvailable ||
      next.upstreamBytesPerSecond !==
        (previous?.upstreamBytesPerSecond ?? null) ||
      next.downstreamBytesPerSecond !==
        (previous?.downstreamBytesPerSecond ?? null)
    ) {
      this.host.events.emit("cellularLinkChanged", {
        available: next.available,
        previouslyAvailable: wasAvailable,
        reasons: next.reasons,
        upstreamBytesPerSecond: next.upstreamBytesPerSecond,
        downstreamBytesPerSecond: next.downstreamBytesPerSecond,
      });
    }
  }

  private logModemChange(change: ModemChange): void {
    const mask = (sim: SimCard) => maskSimIdentifier(sim.iccid) ?? "no iccid";
    const message =
      change.kind === "sim_inserted"
        ? `SIM inserted: ${change.sim.simId} (iccid ${mask(change.sim)}, ${change.sim.subscription})`
        : change.kind === "sim_removed"
          ? `SIM removed: ${change.sim.simId} (iccid ${mask(change.sim)})`
          : change.kind === "sim_replaced"
            ? `SIM replaced: ${change.previous.simId} -> ${change.sim.simId} (iccid ${mask(change.sim)}, ${change.sim.subscription})`
            : change.kind === "subscription_suspended"
              ? `SIM subscription suspended: ${change.sim.simId}`
              : change.kind === "subscription_activated"
                ? `SIM subscription activated: ${change.sim.simId}`
                : change.kind === "reporting_policy_changed"
                  ? `SIM reporting policy: ${change.reporting}`
                  : `Network interface: ${change.networkInterface}`;
    this.host.logger.info(message, LogType.SYSTEM);
  }

  /**
   * Apply network simulation config at runtime. No-op for SOAP charge points
   * (no socket). Stores a summary { enabled, manualRuleIds } for dashboard UI.
   */
  setNetworkSimConfig(resolved: ResolvedNetworkSimConfig): void {
    // Store summary for UI (null for SOAP CPs)
    if (!this.host.isSoapChargePoint()) {
      const manualRuleIds = Object.entries(resolved.rules)
        .filter(([, rule]) => rule.type === "manual-disconnect")
        .map(([id]) => id);
      this._networkSimSummary = {
        enabled: resolved.enabled,
        manualRuleIds,
      };
    }
    this.host.webSocket()?.setNetworkSimConfig(resolved);
  }

  networkSimSummary(): { enabled: boolean; manualRuleIds: string[] } | null {
    return this.host.isSoapChargePoint() ? null : this._networkSimSummary;
  }

  triggerNetworkSimDisconnect(ruleId: string):
    | { ok: true }
    | {
        ok: false;
        error: "sim_disabled" | "rule_not_manual" | "not_connected";
      } {
    const webSocket = this.host.webSocket();
    if (!webSocket) {
      return { ok: false, error: "not_connected" }; // SOAP or no socket
    }
    return webSocket.triggerNetworkSimDisconnect(ruleId);
  }
}
