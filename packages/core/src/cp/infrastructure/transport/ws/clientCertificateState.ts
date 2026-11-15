import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import type { OcppTlsOptions } from "../wsUrlWithBasic";

/** A TLS client certificate chain (PEM) and its private key (PEM). */
export interface ClientIdentity {
  readonly cert: string;
  readonly key: string;
}

/** What the state needs from the socket that owns it. */
export interface ClientCertificateHost {
  readonly logger: Logger;
  /** The configured TLS options (`--tls-*`). */
  tls(): OcppTlsOptions | undefined;
  /** The renewed certificate was discarded after the previous one connected. */
  emitDiscarded(): void;
}

export interface RenewedClientCertificate {
  readonly cert: string;
  readonly key: string;
  readonly fallback?: ClientIdentity;
  confirmed: boolean;
  presentNext: boolean;
}

export class ClientCertificateState {
  /**
   * #537 A02.FR.08: a renewed Charging Station certificate presented in
   * place of the configured `cert` / `key`. Memory-only. `confirmed` once a
   * connection presenting it opened; until then failed attempts alternate
   * between it and `fallback` (2.1 A02.FR.28 with B10.FR.08): the identity
   * in use before it, a previously confirmed renewal or, when absent, the
   * configured one.
   */
  renewed: RenewedClientCertificate | null = null;

  constructor(private readonly host: ClientCertificateHost) {}

  /** Stores `identity` as the renewed certificate (the caller checked the profile). */
  use(identity: ClientIdentity): void {
    const previous = this.renewed;
    // Handed over again (#564): the first hand-over stands, with whatever
    // the connections since have settled about it.
    if (previous?.cert === identity.cert && previous.key === identity.key) {
      return;
    }
    // A02.FR.28: the fallback is the certificate in use, which is a
    // renewal confirmed earlier rather than the configured one.
    const fallback = previous?.confirmed
      ? { cert: previous.cert, key: previous.key }
      : previous?.fallback;
    this.renewed = {
      cert: identity.cert,
      key: identity.key,
      ...(fallback ? { fallback } : {}),
      confirmed: false,
      presentNext: true,
    };
  }

  /** The TLS options of the next attempt, and whether it presents the
   *  renewed certificate. */
  nextTlsOptions(): {
    tls: OcppTlsOptions | undefined;
    renewed: boolean;
  } {
    const renewed = this.renewed;
    if (renewed && (renewed.confirmed || renewed.presentNext)) {
      return { tls: this.tlsWith(renewed), renewed: true };
    }
    const fallback = renewed?.fallback;
    return {
      tls: fallback ? this.tlsWith(fallback) : this.host.tls(),
      renewed: false,
    };
  }

  private tlsWith(identity: ClientIdentity): OcppTlsOptions {
    return {
      ...(this.host.tls() ?? {}),
      cert: identity.cert,
      key: identity.key,
    };
  }

  /** A connection opened: settles which client certificate the station
   *  keeps while the renewed one is unconfirmed (A02.FR.10). */
  onOpened(presentedRenewed: boolean): void {
    const renewed = this.renewed;
    if (!renewed || renewed.confirmed) return;
    if (presentedRenewed) {
      renewed.confirmed = true;
      this.host.logger.info(
        "Connected with the renewed Charging Station certificate (A02.FR.08)",
        LogType.WEBSOCKET,
      );
      return;
    }
    // The certificate in use before the renewal stays the station's.
    const fallback = renewed.fallback;
    this.renewed = fallback
      ? { ...fallback, confirmed: true, presentNext: false }
      : null;
    this.host.logger.warn(
      "Connected with the previous client certificate after the renewed one failed; discarding the renewed certificate (A02.FR.10)",
      LogType.WEBSOCKET,
    );
    this.host.emitDiscarded();
  }

  /** An attempt reached the CSMS and closed before it opened: the next one
   *  presents the other certificate while the renewed one is unconfirmed
   *  (A02.FR.28). */
  onFailed(presentedRenewed: boolean): void {
    const renewed = this.renewed;
    if (!renewed || renewed.confirmed) return;
    renewed.presentNext = !presentedRenewed;
    if (presentedRenewed) {
      this.host.logger.warn(
        "Could not connect with the renewed Charging Station certificate; the next attempt presents the previous one (A02.FR.28)",
        LogType.WEBSOCKET,
      );
    }
  }
}
