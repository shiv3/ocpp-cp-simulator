import type { SimClock } from "../../shared/clock";
import { LogType, type Logger } from "../../shared/Logger";
import { setTimeoutAt } from "../../shared/timers";
import type { CertificateStore } from "../security/CertificateStore";
import type { ChargePointSocket } from "../transport/ChargePointSocket";
import type { GenerationToken } from "../transport/networkSim";
import type { Outbox } from "../transport/Outbox";
import { RENEWED_CERTIFICATE_RECONNECT_MAX_DEFER_MS } from "./ChargePointTypes";

/** How often that wait checks again. */
const RENEWED_CERTIFICATE_RECONNECT_POLL_MS = 500;

/** What the client certificate switch needs from its charge point. */
export interface ClientCertificateSwitchHost {
  readonly logger: () => Logger;
  readonly clock: () => SimClock;
  /** Read through a function: the socket is assigned in the constructor. */
  readonly webSocket: () => ChargePointSocket | null;
  readonly certificateStore: () => CertificateStore;
  readonly outbox: () => Outbox;
  /** The public `reset()` of the charge point (spies must still see it). */
  readonly reset: () => void;
}

/**
 * The renewed Charging Station client certificate switch (#537, #564):
 * request sequencing, the wait for transaction messages in flight and the
 * store watcher. Owns that state; the charge point keeps the public
 * methods as thin delegates.
 */
export class ClientCertificateSwitch {
  /** #537: waits for the transaction messages in flight before reconnecting
   *  with a renewed certificate (A02.FR.08). */
  private _cancelClientCertificateSwitchTimer: (() => void) | null = null;
  /** #537: bumped by every switch request and every cancel, so a request
   *  still reading the store when a newer one (or a cancel) arrives does
   *  nothing once it resumes. */
  private _clientCertificateSwitchSeq = 0;
  /** #537: set by {@link ClientCertificateSwitch.release} (and dispose):
   *  no switch is started any more. */
  private _clientCertificateSwitchReleased = false;
  /** #537: stops following the certificate store (dispose). */
  private _unwatchClientIdentity: (() => void) | null = null;

  constructor(private readonly host: ClientCertificateSwitchHost) {}
  /**
   * #537: the transport presents a renewed Charging Station certificate
   * only while the store holds its key. Once the store's current chain has
   * none (replaced by a chain signed for a caller-supplied CSR, removed),
   * the transport forgets every renewed identity and presents the
   * configured `--tls-cert` again. A new keyed chain is switched to by
   * {@link ClientCertificateSwitch.switchClientCertificate}, not here.
   */
  watchClientIdentity(): void {
    const webSocket = this.host.webSocket();
    if (!webSocket?.usesClientCertificate()) return;
    this._unwatchClientIdentity = this.host.certificateStore().onChange(() => {
      if (!this.host.certificateStore().hasTlsClientIdentity()) {
        webSocket.clearRenewedClientCertificate();
      }
    });
  }

  /** See {@link ChargePoint.useRenewedClientCertificate}. */
  async switchClientCertificate(reconnect: boolean): Promise<void> {
    if (this._clientCertificateSwitchReleased) return;
    this.cancelClientCertificateSwitch();
    const request = this._clientCertificateSwitchSeq;
    const webSocket = this.host.webSocket();
    if (!webSocket?.usesClientCertificate()) return;
    const identity = await this.host.certificateStore().tlsClientIdentity();
    // Superseded by a newer request, or cancelled (dispose, cp.update),
    // while the store was read: that one decides, this one does nothing.
    if (request !== this._clientCertificateSwitchSeq) return;
    if (!identity) {
      webSocket.clearRenewedClientCertificate();
      return;
    }
    // No wait for `notBefore` (A02.FR.08): CertificateSigned refuses a leaf
    // that is not valid yet (A02.FR.06/07, #587), so a stored identity is
    // valid when it is handed over.
    webSocket.useRenewedClientCertificate(identity);
    if (!reconnect) return;
    // A station that is not connected (back-off, simulated outage, manual
    // disconnect) presents it at its next connection, on that one's timing.
    if (!webSocket.isOpenOrConnecting()) {
      this.host
        .logger()
        .info(
          "Renewed Charging Station certificate presented at the next connection (A02.FR.08)",
          LogType.WEBSOCKET,
        );
      return;
    }
    this.reconnectWithRenewedCertificate(
      webSocket.currentGeneration(),
      this.host.clock().now() + RENEWED_CERTIFICATE_RECONNECT_MAX_DEFER_MS,
      identity.cert,
    );
  }

  /** Reconnects once no transaction message awaits its write, an answer
   *  or a resend, or at `deadline`. A connection that closed meanwhile is
   *  not reconnected: the next one presents the renewed certificate. */
  private reconnectWithRenewedCertificate(
    generation: GenerationToken,
    deadline: number,
    cert: string,
  ): void {
    this._cancelClientCertificateSwitchTimer = null;
    const webSocket = this.host.webSocket();
    if (!webSocket?.isOpenOrConnecting()) return;
    if (webSocket.currentGeneration() !== generation) return;
    // Opened with it meanwhile (#564): nothing to switch.
    if (webSocket.presentsClientCertificate(cert)) return;
    if (
      this.host.outbox().hasTransactionMessagesInFlight() &&
      this.host.clock().now() < deadline
    ) {
      this._cancelClientCertificateSwitchTimer = setTimeoutAt(
        Math.min(
          this.host.clock().now() + RENEWED_CERTIFICATE_RECONNECT_POLL_MS,
          deadline,
        ),
        () => this.reconnectWithRenewedCertificate(generation, deadline, cert),
        { clock: this.host.clock() },
      );
      return;
    }
    this.host
      .logger()
      .info(
        "Reconnecting with the renewed Charging Station certificate (A02.FR.08)",
        LogType.WEBSOCKET,
      );
    this.host.reset();
  }

  /**
   * #537: ends the renewed certificate switch for good on an instance being
   * replaced (`cp.update`) or disposed: cancels the in-flight
   * wait, stops following the store, and drops every in-memory key — the
   * transport's renewed identities and the store's private keys. The
   * stored chains stay; the replacement presents the configured
   * `--tls-cert`, as after a restart.
   */
  release(): void {
    this._clientCertificateSwitchReleased = true;
    this.cancelClientCertificateSwitch();
    this._unwatchClientIdentity?.();
    this._unwatchClientIdentity = null;
    this.host.webSocket()?.clearRenewedClientCertificate();
    this.host.certificateStore().forgetPrivateKeys();
  }

  private cancelClientCertificateSwitch(): void {
    this._clientCertificateSwitchSeq++;
    this._cancelClientCertificateSwitchTimer?.();
    this._cancelClientCertificateSwitchTimer = null;
  }

  /** The pending wait's canceller (tests read it through the charge point). */
  get pendingCancel(): (() => void) | null {
    return this._cancelClientCertificateSwitchTimer;
  }
}
