import type { OcppSecurityProfile } from "@ocpp-cp-simulator/contracts/securityProfile";
import type { EventEmitter } from "../../shared/EventEmitter";
import type { WsClientOptions } from "../../shared/WsClientOptions";
import type {
  ReconnectPolicy,
  RetryBackOffVariables,
} from "../../shared/ReconnectPolicy";
import type { NetworkFaultInjected } from "../charge-point/ChargePointEvents";
import type { TlsClientIdentity } from "../security/CertificateStore";
import type {
  CloseCause,
  GenerationToken,
  ResolvedNetworkSimConfig,
} from "./networkSim";

/** What the charge point is told about a socket's close. */
export type SocketClose = Pick<CloseEvent, "code" | "reason">;

/** #448: what the transport reports to observers (the charge point). A
 *  throwing listener is caught by the emitter, never by the transport. */
export interface TransportObserverEvents {
  /** A network-sim disconnect rule fired; emitted before the close. */
  simulatedDisconnect: NetworkFaultInjected;
  /** A reconnect was scheduled; emitted once the close that caused it has
   *  been handed to the `onclose` callback. */
  reconnectScheduled: { attempt: number; delayMs: number };
  /** #609: the reconnect policy's `maxAttempts` was reached; no further
   *  reconnect is scheduled until the next explicit `connect()`. */
  reconnectGaveUp: { attempts: number };
  /** #393: the current generation ended, whatever the cause (a close, a
   *  disconnect, a reset, a simulated drop), or the transport was disposed.
   *  Emitted once per generation, before any replacement socket opens. */
  closed: { cause: CloseCause | "disposed" };
  /** #537 A02.FR.10: a connection opened with the previous client
   *  certificate while the renewed one was unconfirmed; the renewed one is
   *  discarded (A02.FR.29 reports it). */
  renewedClientCertificateDiscarded: Record<string, never>;
}

/**
 * The OCPP-J socket as the charge point drives it (#575). The OCPP-J
 * transport (`infrastructure/transport/OCPPWebSocket`) implements it; a SOAP
 * charge point has none (`null`).
 */
export interface ChargePointSocket {
  /** The URL the next connection attempt uses. */
  readonly url: string;
  readonly observers: EventEmitter<TransportObserverEvents>;
  /** Whether the runtime's socket can send WebSocket pings. */
  readonly supportsPing: boolean;
  setReconnectPolicy(policy: ReconnectPolicy, random?: () => number): void;
  setWsClientOptions(options: WsClientOptions): void;
  setRetryBackOff(variables: RetryBackOffVariables | null): void;
  connectionTrustAnchorsPem(): string | undefined;
  setSecurityCredentials(credentials: {
    securityProfile?: OcppSecurityProfile;
    authorizationKey?: string;
  }): void;
  armSecurityProfileFallback(fallback: () => void): void;
  hasConfiguredTrustAnchors(): boolean;
  hasClientCertificate(): boolean;
  usesClientCertificate(): boolean;
  useRenewedClientCertificate(identity: TlsClientIdentity): void;
  presentsClientCertificate(cert: string): boolean;
  clearRenewedClientCertificate(): void;
  connect(
    onopen?: (() => void) | null,
    onclose?: ((ev: SocketClose, cause: CloseCause) => void) | null,
  ): void;
  disconnect(): void;
  disconnectInternal(): void;
  dispose(): void;
  isConnected(): boolean;
  isOpenOrConnecting(): boolean;
  currentGeneration(): GenerationToken;
  setNetworkSimConfig(resolved: ResolvedNetworkSimConfig): void;
  triggerNetworkSimDisconnect(
    ruleId: string,
  ): { ok: true } | { ok: false; error: "sim_disabled" | "rule_not_manual" };
  setPingInterval(seconds: number): void;
  /** #930: take the link administratively down (`reason`) or up (`null`). */
  setLinkBlocked(reason: string | null): void;
  /** #930: sustained payload caps in bytes per second, `null` = uncapped. */
  setBandwidthLimits(limits: {
    upstreamBytesPerSecond: number | null;
    downstreamBytesPerSecond: number | null;
  }): void;
}
