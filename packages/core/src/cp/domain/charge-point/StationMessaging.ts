import { LogType, type Logger } from "../../shared/Logger";
import type { SimClock } from "../../shared/clock";
import { OcppCallRejectedError } from "../errors/OcppCallErrors";
import type { ChargePointEngine } from "../engine/ChargePointEngine";
import {
  relayGet15118EVCertificate,
  type Get15118EVCertificateRequest,
  type Get15118EVCertificateResult,
} from "../security/get15118EVCertificate";
import type { Outbox } from "../transport/Outbox";
import type { OcppCallActions } from "../transport/OcppCallActions";
import type { RawFrameSink } from "../transport/RawFrameSink";
import type {
  FirmwareStatus,
  UploadLogStatus,
} from "../types/FirmwareLogStatus";
import type {
  CallResultErrorOutcome,
  CallResultErrorRequest,
  OcppCallOutcome,
  OcppCallRequest,
  RawFrameOutcome,
  RawFrameRequest,
} from "../types/OcppCall";
import type { TransactionUpdateOptions } from "../connector/Transaction";
import {
  isSoapVersion,
  OCPP_2_1,
  parseOcppVersion,
} from "../types/OcppVersion";
import type { ChargePoint } from "./ChargePoint";
import type { ChargePointTransport } from "./ChargePointDeps";

/** What the expert sends and status notifications need from their charge
 *  point. */
export interface StationMessagingHost {
  /** Public members go through it so spies on the charge point still see
   *  them. */
  readonly chargePoint: Pick<ChargePoint, "getConnector" | "sendOcppCall">;
  readonly callCatalog: () => OcppCallActions | null;
  readonly clock: () => SimClock;
  readonly engine: () => ChargePointEngine;
  readonly logger: () => Logger;
  readonly ocppVersion: () => string;
  readonly outbox: () => Outbox;
  readonly rawFrames: () => RawFrameSink | null;
}

/**
 * The calls a station sends on request rather than by its own protocol flow:
 * expert OCPP calls and raw frames (#389, #393), the Get15118EVCertificate
 * relay (#537) and the firmware / log status notifications with the request
 * ids they report. The charge point keeps the public methods as thin
 * delegates.
 */
export class StationMessaging {
  /** §4.9 S3: whether this SOAP CP has a soapCallbackUrl (server-hosted) vs
   *  send-only (browser local mode). For non-SOAP versions, always false.
   *  Set by the charge point constructor. */
  hasSoapCallbackUrl = false;
  /** SOAP dialect dispatch check; see {@link ChargePointTransport.receivesCsmsCall}.
   *  Set by the charge point constructor. */
  receivesCsmsCall!: ChargePointTransport["receivesCsmsCall"];

  constructor(private readonly host: StationMessagingHost) {}

  /**
   * §4.9 S3: check whether this charge point can receive a CSMS-initiated call.
   *
   * WebSocket versions can receive all CSMS calls. SOAP versions depend on:
   * - Send-only (no soapCallbackUrl): cannot receive any calls (no server).
   * - Server-hosted (with callback): the action must be dispatchable in the
   *   version's dialect — declared with target "cp", or a bidirectional op
   *   (DataTransfer). Mirrors OCPPSoapServer's dispatch rule so the guard
   *   matches what the server actually answers (issue #257: 1.5 now dispatches
   *   its full CS→CP surface, not just Reset).
   */
  canReceiveCsmsCall(action: string): boolean {
    // WebSocket versions can receive all CSMS calls
    if (!isSoapVersion(this.host.ocppVersion())) {
      return true;
    }

    // SOAP versions without a callback URL (send-only, e.g. browser local mode)
    // cannot receive any CSMS-initiated calls — there's no server to host the callback.
    if (!this.hasSoapCallbackUrl) {
      return false;
    }

    // SOAP with callback: the action must be dispatchable in this dialect —
    // target "cp" or a bidirectional op — matching OCPPSoapServer dispatch.
    return this.receivesCsmsCall(action) === true;
  }

  /**
   * Drive an OCPP 2.x TransactionEvent(Updated) on a running transaction
   * (#335). On OCPP 1.6 the handler logs a warning and sends nothing.
   */
  sendTransactionUpdate(
    connectorId: number,
    options: TransactionUpdateOptions,
  ): void {
    const connector = this.host.chargePoint.getConnector(connectorId);
    if (!connector) {
      this.host
        .logger()
        .error(`Connector ${connectorId} not found`, LogType.TRANSACTION);
      return;
    }
    this.host.outbox().sendTransactionUpdate(connectorId, options);
  }

  /**
   * Expert OCPP call (#389): any station-initiated CALL of this station's
   * OCPP-J version, with the payload as given. See
   * {@link IChargePointMessageHandler.sendOcppCall}.
   */
  async sendOcppCall(request: OcppCallRequest): Promise<OcppCallOutcome> {
    const catalog = this.host.callCatalog();
    if (!catalog) {
      throw new OcppCallRejectedError(
        "unsupported_transport",
        `Expert OCPP calls need an OCPP-J station; ${this.host.ocppVersion()} is SOAP`,
      );
    }
    // Checked here, not by the schema, so skipValidation cannot waive it:
    // the scenario editor can store unparsed JSON text as the payload.
    const { payload } = request;
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new OcppCallRejectedError(
        "invalid_payload",
        "The payload of an OCPP call must be a JSON object",
      );
    }
    if (!catalog.isSupported(request.action)) {
      throw new OcppCallRejectedError(
        "unsupported_action",
        `${request.action} is not a station-initiated call on ${this.host.ocppVersion()}; expected one of ${catalog.actions.join(", ")}`,
      );
    }
    return this.host.outbox().sendOcppCall(request);
  }

  /**
   * Expert raw frame (#393, level C of #389): one text frame written to the
   * WebSocket as given, valid OCPP-J or not, outside the 1.6 serial CALL
   * queue. Replies are correlated best effort and kept from the station's
   * handlers. See {@link RawFrameSink}.
   */
  sendRawFrame(request: RawFrameRequest): Promise<RawFrameOutcome> {
    const rawFrames = this.host.rawFrames();
    if (!rawFrames) {
      return Promise.reject(
        new OcppCallRejectedError(
          "unsupported_transport",
          `Raw frames need an OCPP-J station; ${this.host.ocppVersion()} is SOAP`,
        ),
      );
    }
    return rawFrames.send(request);
  }

  /**
   * Answer a CALLRESULT the station received with a CALLRESULTERROR (OCPP 2.1
   * Part 2 FR.06, RPC framework message type 5): `[5, messageId, errorCode,
   * errorDescription, errorDetails]`. OCPP-J 2.1 only: no other version has
   * the message type. Written as a raw frame, so the CSMS's reaction (if any)
   * is not awaited.
   */
  async sendCallResultError(
    request: CallResultErrorRequest,
  ): Promise<CallResultErrorOutcome> {
    if (parseOcppVersion(this.host.ocppVersion()) !== OCPP_2_1) {
      throw new OcppCallRejectedError(
        "unsupported_action",
        `CALLRESULTERROR is an OCPP 2.1 message type; this station speaks ${this.host.ocppVersion()}`,
      );
    }
    if (request.messageId === "") {
      throw new OcppCallRejectedError(
        "invalid_payload",
        "A CALLRESULTERROR needs the id of the CALL that was answered",
      );
    }
    const frame = JSON.stringify([
      5,
      request.messageId,
      request.errorCode ?? "FormatViolation",
      request.errorDescription ?? "",
      request.errorDetails ?? {},
    ]);
    await this.sendRawFrame({ frame, waitMs: 0 });
    return { sentFrame: frame, messageId: request.messageId };
  }

  /**
   * 2.0.1 / 2.1 Get15118EVCertificate relay (M01 / M02, #537): sends the EXI
   * request the caller supplies, standing in for an EV, and resolves with
   * the CSMS's answers. See {@link relayGet15118EVCertificate}. Each request
   * goes through {@link sendOcppCall}, so it is refused before anything is
   * written on 1.6 and SOAP stations, which have no such message, and when
   * the payload fails the version's schema (a 2.1-only field or an
   * over-long `exiRequest` on 2.0.1).
   */
  async get15118EVCertificate(
    request: Get15118EVCertificateRequest,
  ): Promise<Get15118EVCertificateResult> {
    return relayGet15118EVCertificate(
      request,
      (payload) =>
        this.host.chargePoint.sendOcppCall({
          action: "Get15118EVCertificate",
          payload,
        }),
      {
        warn: (message) => this.host.logger().warn(message, LogType.OCPP),
        clock: this.host.clock(),
      },
    );
  }

  /** Send FirmwareStatusNotification.req — see OCPPMessageHandler doc. */
  sendFirmwareStatusNotification(
    status: FirmwareStatus,
    requestId?: number,
  ): void {
    this.host.outbox().sendFirmwareStatusNotification(status, requestId);
    // Whichever route sent it (control plane, scenario, behavior), the engine
    // holds what was last reported, so a TriggerMessage answers it (#596).
    // The 2.x handler names the last accepted request when none is given,
    // except for Idle.
    const reported =
      requestId ??
      (status === "Idle" ? undefined : this._lastFirmwareRequestId);
    this.host.engine().dispatch({
      type: "reported",
      kind: "firmware",
      status,
      ...(reported !== undefined ? { requestId: reported } : {}),
    });
  }

  /** Send LogStatusNotification.req — see OCPPMessageHandler doc. */
  sendLogStatusNotification(status: UploadLogStatus, requestId?: number): void {
    this._logStatusSeq++;
    this._lastLogStatusRequestId = requestId ?? this._lastLogRequestId;
    this.host.outbox().sendLogStatusNotification(status, requestId);
    const reported =
      requestId ?? (status === "Idle" ? undefined : this._lastLogRequestId);
    this.host.engine().dispatch({
      type: "reported",
      kind: "log",
      status,
      ...(reported !== undefined ? { requestId: reported } : {}),
    });
  }

  /** Counts every LogStatusNotification this station sent, so the automatic
   *  GetLog lifecycle can tell that something else (the control plane, a
   *  scenario `notify` node) is driving the status train of its request
   *  (N01.FR.09: one final status per requestId). */
  private _logStatusSeq = 0;
  private _lastLogStatusRequestId: number | undefined;
  get logStatusSeq(): number {
    return this._logStatusSeq;
  }
  get lastLogStatusRequestId(): number | undefined {
    return this._lastLogStatusRequestId;
  }

  /** `requestId` of the last UpdateFirmware.req this station accepted, so a
   *  2.0.1 FirmwareStatusNotification sent without one still names the
   *  lifecycle it belongs to (#345). Kept until the next accepted request —
   *  deliberately across reconnects and reboots, since a real update reports
   *  `Installed` only after the station has rebooted on the new firmware. */
  private _lastFirmwareRequestId: number | undefined;
  /** Same for GetLog.req → LogStatusNotification. */
  private _lastLogRequestId: number | undefined;

  noteFirmwareRequest(requestId: number): void {
    this._lastFirmwareRequestId = requestId;
  }
  get lastFirmwareRequestId(): number | undefined {
    return this._lastFirmwareRequestId;
  }
  noteLogRequest(requestId: number): void {
    this._lastLogRequestId = requestId;
  }
  get lastLogRequestId(): number | undefined {
    return this._lastLogRequestId;
  }

  /** Send SignedFirmwareStatusNotification.req — see OCPPMessageHandler doc. */
  sendSignedFirmwareStatusNotification(
    status: FirmwareStatus,
    requestId?: number,
  ): void {
    this.host.outbox().sendSignedFirmwareStatusNotification(status, requestId);
  }
}
