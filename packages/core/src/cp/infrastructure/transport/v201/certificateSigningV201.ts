import type {
  GetCertificateStatusRequestV201,
  GetCertificateStatusResponseV201,
  SignCertificateRequestV201,
  SignCertificateResponseV201,
} from "@ocpp-cp-simulator/ocpp/index";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { clockOf, unrefTimerHandle } from "../../../shared/clock";
import type { SimClock, TimerHandle } from "../../../shared/clock";
import { OCPP_2_1 } from "../../../domain/types/OcppVersion";
import { SignCertificateBackoff } from "../../../domain/security/SignCertificateBackoff";
import {
  V2G_CERTIFICATE_USES,
  type SignedCertificateUse,
} from "../../../domain/security/certificateUse";
import {
  V201_CERTIFICATE_MAPPING,
  V21_CERTIFICATE_MAPPING,
  type CertificateWireMapping,
} from "./certificatesV201";
import type {
  V201Action,
  V201CertificateSigning,
  V201RequestPayload,
} from "./inboundRegistryV201";

/** M06.FR.10: the cached OCSP data is refreshed at least once a week. */
const CERTIFICATE_STATUS_REFRESH_MS = 7 * 24 * 3600 * 1000;

/** What the outbound certificate signing needs from the handler. */
export interface CertificateSigningContext {
  readonly chargePoint: Pick<
    ChargePoint,
    | "adoptRenewedClientCertificate"
    | "certificateQuirks"
    | "certificateStore"
    | "clock"
    | "configuration"
    | "id"
    | "ocppVersion"
    | "sendSecurityEventNotification"
    | "useRenewedClientCertificate"
  >;
  readonly logger: Logger;
  generateMessageId(): string;
  send(
    action: V201Action,
    messageId: string,
    payload: V201RequestPayload,
  ): void;
}

/**
 * The station side of A02 / A03 certificate signing and M06 OCSP status on
 * 2.x (#456, #537, #720): SignCertificateRequest with its A02.FR.17 resend
 * back-off, the answers to it and to GetCertificateStatusRequest, the weekly
 * OCSP refresh and the port the inbound CertificateSigned / TriggerMessage
 * handlers drive (#877).
 */
export class CertificateSigningV201 {
  private readonly _chargePoint: CertificateSigningContext["chargePoint"];
  private readonly _logger: Logger;
  /** #537: the last SignCertificateRequest sent per certificate use, what
   *  the A02.FR.17 back-off resends. */
  private readonly _signRequests = new Map<
    SignedCertificateUse,
    SignCertificateRequestV201
  >();
  /** #720 A02.FR.24: the `requestId` of every 2.1 SignCertificateRequest
   *  the station sent; a CertificateSigned carrying another id is Rejected
   *  (A02.FR.26). */
  private readonly _issuedSignRequestIds = new Set<number>();
  private _nextSignRequestId = 1;
  private readonly _signBackoff: SignCertificateBackoff;
  readonly certificateSigning: V201CertificateSigning = {
    requestSignature: (use) => this.requestSignature(use),
    isKnownSignRequestId: (requestId) =>
      this._issuedSignRequestIds.has(requestId),
    requestCombinedSignature: () => this.sendSignCertificate(),
    certificateStored: (use) => {
      if (use === "ChargingStationCertificate") {
        // #564 A02.FR.08: the next connection presents it, whatever becomes
        // of the answer. The reconnect of an open one waits for the answer.
        void this._chargePoint.adoptRenewedClientCertificate();
      }
    },
    certificateRejected: (use) => this._signBackoff.stop(use),
    certificateInstalled: (use) => {
      this._signBackoff.stop(use);
      if (V2G_CERTIFICATE_USES.includes(use)) {
        this.requestCertificateStatus([use]);
      } else if (use === "ChargingStationCertificate") {
        // #537 A02.FR.08: the answer is written; reconnect with it as the
        // TLS client certificate.
        void this._chargePoint.useRenewedClientCertificate();
      }
    },
  };
  /** #537 2.1 A02.FR.29: a renewed certificate was discarded; reported
   *  after the next accepted boot. */
  private _renewedClientCertificateDiscarded = false;
  /** #537 M06.FR.10: the weekly OCSP refresh, running while booted. */
  private _certificateStatusRefresh: TimerHandle | null = null;

  constructor(private readonly ctx: CertificateSigningContext) {
    this._chargePoint = ctx.chargePoint;
    this._logger = ctx.logger;
    const chargePoint = ctx.chargePoint;
    this._signBackoff = new SignCertificateBackoff({
      settings: () => ({
        waitMinimumSeconds:
          this._chargePoint.configuration.certSigningWaitMinimum(),
        repeatTimes: this._chargePoint.configuration.certSigningRepeatTimes(),
      }),
      isPending: (use) =>
        this._chargePoint.certificateStore.pendingCsr(use) !== undefined,
      resend: (use) => this.resendSignCertificate(use),
      clock: chargePoint.clock,
    });
  }

  /** The charge point's clock (the platform clock for a stand-in without one). */
  private get clock(): SimClock {
    return clockOf(this._chargePoint);
  }

  private generateMessageId(): string {
    return this.ctx.generateMessageId();
  }

  private send(
    action: V201Action,
    messageId: string,
    payload: V201RequestPayload,
  ): void {
    this.ctx.send(action, messageId, payload);
  }

  /** The socket discarded a renewed client certificate (#537). */
  public onRenewedClientCertificateDiscarded(): void {
    // DiscardedRenewedClientCertificate is a 2.1 security event only.
    if (this._chargePoint.ocppVersion === OCPP_2_1) {
      this._renewedClientCertificateDiscarded = true;
    }
  }

  /** The certificate-use mapping of this station's OCPP version. */
  private certificateMapping(): CertificateWireMapping {
    return this._chargePoint.ocppVersion === OCPP_2_1
      ? V21_CERTIFICATE_MAPPING
      : V201_CERTIFICATE_MAPPING;
  }

  /** The certificate use a SignCertificateRequest asks for: absent means
   *  the Charging Station certificate (#456). */
  private signRequestUse(
    request: SignCertificateRequestV201,
  ): SignedCertificateUse {
    return (
      this.certificateMapping().signedUseFrom(request.certificateType ?? "") ??
      "ChargingStationCertificate"
    );
  }

  /**
   * A02 SignCertificateResponse (#456), the 2.x twin of 1.6's #410 result
   * handling: logged only. A Rejected answer (A02.FR.12) leaves the CSR
   * pending: A02 has no rule to discard it, and a CertificateSigned that
   * still arrives for it can be matched. An Accepted answer starts, or
   * continues, the resend back-off of the request's certificate use
   * (A02.FR.17/18, #537); any other answer ends it. An answer to a request
   * a newer CSR replaced, or to a given CSR that does not parse, leaves the
   * back-off alone: it is not the request the back-off follows.
   */
  public applySignCertificateResult(
    request: SignCertificateRequestV201,
    response: SignCertificateResponseV201,
  ): void {
    const use = this.signRequestUse(request);
    if (this._signRequests.get(use)?.csr !== request.csr) {
      this._logger.info(
        `[v2.0.1] SignCertificate ${response.status} for a ${use} CSR that is not the current one; ignored`,
        LogType.OCPP,
      );
      return;
    }
    if (response.status === "Accepted") {
      this._logger.info(
        "[v2.0.1] SignCertificate accepted by the CSMS; awaiting CertificateSigned",
        LogType.OCPP,
      );
      this._signBackoff.accepted(use);
      return;
    }
    this._signBackoff.notAccepted(use);
    this._logger.warn(
      `[v2.0.1] SignCertificate not accepted by the CSMS (status ${response.status}); the CSR stays pending`,
      LogType.OCPP,
    );
  }

  /**
   * A02 SignCertificateRequest (#456): sends `csr` as given, or a CSR newly
   * generated by the certificate store, and records it as the pending
   * Charging Station certificate CSR that CertificateSigned is matched
   * against. `certificateType` is omitted (the certificate serves every
   * connection, A02.FR.13 does not apply), and so is the optional 2.1
   * `hashRootCertificate`, which the station has no source for. On 2.1 the
   * request carries a `requestId` (A02.FR.24, #720).
   */
  public async sendSignCertificate(csr?: string): Promise<void> {
    const store = this._chargePoint.certificateStore;
    let payloadCsr: string;
    if (csr) {
      payloadCsr = csr;
      if (!store.recordPendingCsr("ChargingStationCertificate", csr)) {
        this._logger.warn(
          "[v2.0.1] SignCertificate: the given CSR is not a parseable PKCS#10 request; no CertificateSigned can match it",
          LogType.OCPP,
        );
        // Not the pending CSR: the back-off and what it resends stay its own.
        this.send(
          "SignCertificate",
          this.generateMessageId(),
          this.withSignRequestId({ csr }),
        );
        return;
      }
    } else {
      payloadCsr = await this.generateCsr("ChargingStationCertificate");
    }
    this.sendSignCertificateRequest("ChargingStationCertificate", {
      csr: payloadCsr,
    });
  }

  /**
   * TriggerMessage SignChargingStationCertificate / SignV2GCertificate
   * (#537): a new key pair and CSR (A02.FR.02), sent with the triggered
   * certificateType (A02.FR.03/13).
   */
  private async requestSignature(use: SignedCertificateUse): Promise<void> {
    const csr = await this.generateCsr(use);
    this.sendSignCertificateRequest(use, {
      csr,
      // The 2.1 enum is a superset of the 2.0.1 one.
      certificateType: (this.certificateMapping().signedUseTo(use) ??
        "ChargingStationCertificate") as SignCertificateRequestV201["certificateType"],
    });
  }

  private async generateCsr(use: SignedCertificateUse): Promise<string> {
    const quirks = this._chargePoint.certificateQuirks;
    if (quirks.csrKeyAlgorithm === "RSA") {
      this._logger.info(
        "[v2.0.1] SignCertificate: generating RSA CSR (certificate quirk)",
        LogType.OCPP,
      );
    }
    return this._chargePoint.certificateStore.generateNewCsr(
      this._chargePoint.id,
      this._chargePoint.configuration.getString("CpoName") ?? "",
      {
        keyAlgorithm: quirks.csrKeyAlgorithm,
        pemLineEndings: quirks.csrPemLineEndings,
      },
      use,
    );
  }

  /** A new SignCertificateRequest: its back-off starts over once it is
   *  accepted (A02.FR.19). */
  private sendSignCertificateRequest(
    use: SignedCertificateUse,
    payload: SignCertificateRequestV201,
  ): void {
    this._signBackoff.restart(use);
    const request = this.withSignRequestId(payload);
    this._signRequests.set(use, request);
    this.send("SignCertificate", this.generateMessageId(), request);
  }

  /** 2.1 A02.FR.24 / A03.FR.20: the request gets a `requestId` the station
   *  remembers as its own; a back-off resend sends the stored request, so
   *  it keeps the id. 2.0.1 has no such field. */
  private withSignRequestId(
    payload: SignCertificateRequestV201,
  ): SignCertificateRequestV201 {
    if (this._chargePoint.ocppVersion !== OCPP_2_1) return payload;
    const requestId = this._nextSignRequestId++;
    this._issuedSignRequestIds.add(requestId);
    return { ...payload, requestId } as SignCertificateRequestV201;
  }

  /**
   * M06 GetCertificateStatusRequest (#537), one per certificate of the
   * stored `uses` chains that names an OCSP responder (M06 remark: one
   * certificate per request). A responderURL longer than the schema
   * allows (512 on 2.0.1, 2000 on 2.1) is left out with a WARN.
   */
  private requestCertificateStatus(
    uses: readonly SignedCertificateUse[] = V2G_CERTIFICATE_USES,
  ): void {
    const maxUrl = this._chargePoint.ocppVersion === OCPP_2_1 ? 2000 : 512;
    const store = this._chargePoint.certificateStore;
    for (const use of uses) {
      for (const ocspRequestData of store.ocspRequestData(use)) {
        if (ocspRequestData.responderURL.length > maxUrl) {
          this._logger.warn(
            `[v2.0.1] GetCertificateStatus: ${use} certificate ${ocspRequestData.serialNumber} has a responderURL over ${maxUrl} characters; not asked`,
            LogType.OCPP,
          );
          continue;
        }
        const payload: GetCertificateStatusRequestV201 = { ocspRequestData };
        this.send("GetCertificateStatus", this.generateMessageId(), payload);
      }
    }
  }

  /** M06.FR.02-04: an Accepted answer's ocspResult is cached for the
   *  certificate asked about; Failed leaves the cache as it was. */
  public applyCertificateStatusResult(
    request: GetCertificateStatusRequestV201,
    response: GetCertificateStatusResponseV201,
  ): void {
    const serial = request.ocspRequestData.serialNumber;
    if (response.status === "Accepted" && response.ocspResult !== undefined) {
      this._chargePoint.certificateStore.cacheOcspResponse(
        request.ocspRequestData,
        response.ocspResult,
      );
      this._logger.info(
        `[v2.0.1] GetCertificateStatus: cached the OCSP response for certificate ${serial}`,
        LogType.OCPP,
      );
      return;
    }
    this._logger.warn(
      `[v2.0.1] GetCertificateStatus: no OCSP response for certificate ${serial} (status ${response.status})`,
      LogType.OCPP,
    );
  }

  private stopCertificateStatusRefresh(): void {
    if (this._certificateStatusRefresh !== null) {
      this.clock.clearInterval(this._certificateStatusRefresh);
      this._certificateStatusRefresh = null;
    }
  }

  /** A02.FR.17: the same request again, no CertificateSigned having come. */
  private resendSignCertificate(use: SignedCertificateUse): void {
    const payload = this._signRequests.get(use);
    if (!payload) return;
    this._logger.info(
      `[v2.0.1] SignCertificate: no CertificateSigned for the ${use} CSR in time; resending it (A02.FR.17)`,
      LogType.OCPP,
    );
    this.send("SignCertificate", this.generateMessageId(), payload);
  }

  /** A new boot status: an accepted boot (re)starts the OCSP refresh and
   *  the sign back-off (#537). */
  public onBootStatus(status: { status: string }): void {
    // #537 M06.FR.06/10: every accepted boot asks for the OCSP status of
    // the stored V2G certificates, then again every week while connected.
    if (status.status === "Accepted") {
      this.stopCertificateStatusRefresh();
      this.requestCertificateStatus();
      const refresh = this.clock.setInterval(
        () => this.requestCertificateStatus(),
        CERTIFICATE_STATUS_REFRESH_MS,
      );
      unrefTimerHandle(refresh);
      this._certificateStatusRefresh = refresh;
      this._signBackoff.resumeAll();
      // #537 2.1 A02.FR.29: the connection that discarded a renewed
      // certificate is the one now booted.
      if (this._renewedClientCertificateDiscarded) {
        this._renewedClientCertificateDiscarded = false;
        this._chargePoint
          .sendSecurityEventNotification("DiscardedRenewedClientCertificate")
          .catch((err: unknown) => {
            this._logger.warn(
              `DiscardedRenewedClientCertificate not sent: ${err instanceof Error ? err.message : String(err)}`,
              LogType.OCPP,
            );
          });
      }
    }
  }

  /** The connection closed (#537). */
  public onConnectionClosed(): void {
    // #537: the weekly OCSP refresh dies with the connection too. The
    // SignCertificate back-off waits for the next accepted boot: A02.FR.17
    // still holds for a CSR the CSMS accepted before this close.
    this._signBackoff.holdAll();
    this.stopCertificateStatusRefresh();
  }
}
