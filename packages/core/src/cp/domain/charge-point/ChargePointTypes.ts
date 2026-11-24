import type { ChargerCapabilities } from "./ChargerCapabilities";
import type { ChargePointCapabilityProfile } from "./CapabilityProfile";
import type { ModemConfig } from "../modem/CellularModem";
import type { MeterValueDecimalSeparator } from "../connector/meterQuirks";
import type {
  IdTokenTypeName,
  TransactionChargingState,
  TransactionStartTriggerReason,
  TransactionStopTriggerReason,
  TransactionStoppedReason,
} from "../connector/Transaction";
import type { SimClock } from "../../shared/clock";
import type { RngSource } from "../../shared/rng";
import type { IdTagDistribution } from "../auth/IdTagPool";
import type { UrlDistribution } from "../transport/UrlDistribution";
import type { WsClientOptions } from "../../shared/WsClientOptions";
import type { ReconnectPolicy } from "../../shared/ReconnectPolicy";

/**
 * #537: how long the reconnect that presents a renewed Charging Station
 * certificate waits for the transaction messages in flight (a
 * TransactionEvent awaiting its write or its answer, or one waiting to be
 * resent) to settle. The close would not lose them: the 2.x E11 queue
 * takes them and replays them, marked offline, after the next accepted
 * boot (#528). Waiting avoids marking offline, and resending, events the
 * CSMS was about to settle. Past this bound the station reconnects anyway
 * and the close queues what is still in flight.
 */
export const RENEWED_CERTIFICATE_RECONNECT_MAX_DEFER_MS = 60_000;

export interface BasicAuthSettings {
  username: string;
  password: string;
}

export interface AutoMeterValueSetting {
  enabled: boolean;
  interval: number;
  value: number;
}

export interface StartTransactionOptions {
  /** #697 (2.x, internal): the cable starts the transaction before any
   *  idToken is authorized (`TxStartPoint` `EVConnected`). */
  awaitAuthorization?: boolean;
  /** #697 (2.x, internal): the idToken was authorized already (while the
   *  cable was out, `TxStartPoint` `EVConnected`); the plug-in applies it
   *  without a second Authorize. */
  preAuthorized?: boolean;
  triggerReason?: TransactionStartTriggerReason;
  remoteStartId?: number;
  /** OCPP 2.x Started-event chargingState (#335); `Charging` when absent. */
  chargingState?: TransactionChargingState;
  /** Target SoC of this session in percent (#327); the writer of
   *  `Transaction.targetSoc`. Absent: the connector's EV settings default. */
  targetSoc?: number;
  /** Stop the session when it reaches the target SoC (#327); absent: the
   *  connector's `stopAtTargetSoc` setting decides. */
  stopAtTarget?: boolean;
  /** OCPP 2.x `IdToken.type` of the transaction's Authorize and
   *  TransactionEvents (#599); `ISO14443` when absent. */
  idTokenType?: IdTokenTypeName;
  /** The `groupIdToken` of a RequestStartTransaction (F01.FR.21/22): the group
   *  the reservation check uses for this start, before what the station
   *  knows of the token. */
  groupIdToken?: string;
}

/**
 * Result of `ChargePoint.startTransaction` (issue #181). Non-throwing: a
 * denied local-authorize gate is reported here rather than as a thrown
 * error, so scenario-layer callers can log-and-continue instead of
 * aborting. `denialStatus` is only set when `started` is `false` because
 * Authorize.conf came back non-Accepted; the other early-return guards
 * (connector missing/busy/inoperative) leave it `undefined`.
 */
export interface StartTransactionOutcome {
  started: boolean;
  denialStatus?: string;
}

export interface StopTransactionOptions {
  triggerReason?: TransactionStopTriggerReason;
  /** OCPP 2.x Ended-event stoppedReason named explicitly (#335); when
   *  absent the encoder derives it from the 1.6 `reason`. */
  stoppedReason?: TransactionStoppedReason;
  /** The instant the transaction ended when it is not now: the power loss a
   *  recovery reports after the reboot (#455). */
  stoppedAt?: Date;
}

/** What survives a power loss (#455): the instant and the transactions that
 *  were running, the persisted state a recovery works from. */
export interface PowerLossRecord {
  at: Date;
  transactions: { connectorId: number; transactionId: number }[];
}

/**
 * How a restored station treats the transactions the power loss interrupted
 * (#455).
 * - `resume` keeps them running (1.6 leaves this to the implementation; 2.1
 *   E17.FR.10-14 requires it within `TxResumptionTimeout`).
 * - `end` reports them ended with reason `PowerLoss` (1.6 §7.36 StopTransaction
 *   reasons; 2.x E17.FR.20-21).
 */
export type PowerRecovery = "resume" | "end";

export interface PowerRestoreOptions {
  /** Default: `resume` on 1.x and 2.1, `end` on 2.0.1 (no `TxResumed`). */
  transactions?: PowerRecovery;
  /** OCPP 2.1 `TxCtrlr.TxResumptionTimeout` stand-in: a transaction resumes
   *  only when the outage lasted at most this many seconds. Absent or 0
   *  means the station does not resume (E17.FR.01, TC_E_114/115). */
  txResumptionTimeoutSeconds?: number;
}

/** `restoreAfterMs`: power returns by itself after this long (the outage
 *  duration); without it the station stays off until {@link ChargePoint.restorePower}. */
export interface PowerLossOptions extends PowerRestoreOptions {
  restoreAfterMs?: number;
}

export interface PowerRestoreResult {
  outageMs: number;
  recovery: PowerRecovery | "none";
  transactions: number;
}

/**
 * `powerLoss` while off, `powerRestore` while on, and a transaction, boot or
 * reset command while the station is without power (`powered_off`, #798).
 */
export class PowerStateError extends Error {
  constructor(
    readonly code:
      | "already_powered_off"
      | "not_powered_off"
      | "unsupported_transport"
      | "powered_off",
  ) {
    super(
      code === "already_powered_off"
        ? "The charge point is already without power"
        : code === "unsupported_transport"
          ? "Power loss is not simulated for OCPP-S (SOAP) charge points"
          : code === "powered_off"
            ? "The charge point is without power; restore it first"
            : "The charge point has power",
    );
  }
}

/**
 * Per-action inbound call policy (issue #247). When a CSMS-initiated CALL
 * arrives for an action with a policy, the CP replies with CALLERROR or
 * remains silent instead of processing normally. Policies are sticky and
 * survive reconnects — they must be explicitly cleared (not one-shot like
 * responseOverride).
 */
export type InboundCallPolicy =
  | { kind: "callerror"; errorCode: string; errorDescription: string }
  | { kind: "ignore" };

/**
 * What a response override answers an inbound CSMS CALL with. The one-shot
 * `{ status }` override of issue #110 is `mode: "status"`; the other modes are
 * for tests that need the station to misbehave on the wire, so none of them is
 * validated against the action's response schema.
 *
 * - `status`: CALLRESULT `{ status }`
 * - `callError`: CALLERROR with the given code, description and details
 * - `callResult`: CALLRESULT with `payload` as given (schema-valid or not)
 * - `raw`: `frame` written to the socket as given instead of an answer
 * - `callResultError`: an OCPP 2.1 CALLRESULTERROR frame (type 5) carrying
 *   the CALL's message id, in place of the answer
 * - `delay`: the normal answer, written `delayMs` later
 * - `noAnswer`: the CALL is left unanswered
 *
 * Every mode but `delay` and `noAnswer` may also carry `delayMs`: the answer
 * is then written that long after the decision.
 */
export type ResponseOverrideSpec =
  | { mode: "status"; status: string; delayMs?: number }
  | {
      mode: "callError";
      errorCode: string;
      errorDescription?: string;
      errorDetails?: Record<string, unknown>;
      delayMs?: number;
    }
  | { mode: "callResult"; payload: unknown; delayMs?: number }
  | { mode: "raw"; frame: string; delayMs?: number }
  | {
      mode: "callResultError";
      errorCode: string;
      errorDescription?: string;
      errorDetails?: Record<string, unknown>;
      delayMs?: number;
    }
  | { mode: "delay"; delayMs: number }
  | { mode: "noAnswer" };

/** How often a {@link ResponseOverrideSpec} fires: `times` CALLs (default 1),
 *  or until cleared with `persistent`. */
export interface ResponseOverrideRepeat {
  times?: number;
  persistent?: boolean;
}

/**
 * Certificate quirks for CSR generation and acceptance (issue #247).
 * Used to emulate OCPP conformance tool behavior and test edge cases.
 * All fields are optional; unset fields revert to default behavior.
 */
export interface CertificateQuirks {
  /** Key algorithm for generated CSRs. Default (unset): ECDSA P-256. */
  csrKeyAlgorithm?: "ECDSA" | "RSA";
  /** Line endings for emitted CSR PEM. Default (unset): "lf". */
  csrPemLineEndings?: "lf" | "crlf";
  /** Accepted signature algorithms for certificates received via CertificateSigned.
   *  Unset/empty = accept anything (default behavior). The handler checks the leaf
   *  certificate's signature algorithm name (via X509Certificate.signatureAlgorithm.name)
   *  and rejects the chain if its name is not in this list. Matchable algorithm names
   *  include "ECDSA" (P-256, P-384, P-521), "RSASSA-PKCS1-v1_5" (RSA PKCS#1),
   *  and "RSA-PSS" (RSA-PSS). */
  requiredCertificateSignatureAlgorithms?: string[];
  /** OCPP 1.6 configuration keys to omit from GetConfiguration responses.
   *  When a hidden key is requested by name, it appears in the response's
   *  unknownKey array instead of the configurationKey list. Unset/empty =
   *  no keys are hidden (default behavior). */
  hiddenConfigurationKeys?: string[];
}

/**
 * What makes a run replayable (docs/concepts/charger-engine.md): the clock
 * every timer and timestamp of the charge point reads, and the seed its
 * random streams derive from. With neither, the platform clock and
 * `Math.random` are used and nothing differs from a charge point built
 * without this argument.
 */
export interface ChargePointSimulationOptions {
  readonly clock?: SimClock;
  /** A seed (a string or a number) or ready-made streams. */
  readonly seed?: string | number | RngSource;
}

export type ChargePointResetType = "Hard" | "Soft";

/**
 * What an OCPP 1.6J charge point does with an inbound CALL whose payload
 * breaks the request schema (#593): `off` skips the check, `warn` logs it and
 * runs the handler anyway, `enforce` answers a CALLERROR (OCPP-J 1.6 §4.2.3).
 */
export type InboundValidationMode = "off" | "warn" | "enforce";
export const DEFAULT_INBOUND_VALIDATION: InboundValidationMode = "warn";

export interface ChargePointTransportOptions {
  /** What the charger hardware delivers per connector (#327). Absent:
   *  no connector is capped. */
  readonly chargerCapabilities?: ChargerCapabilities;
  /** Cellular modem and SIM model (#928). Absent: no modem model, and the
   *  BootNotification keeps its static `iccid` / `imsi`. Persisted state for
   *  the charge point's id wins over this initial state. */
  readonly modem?: ModemConfig;
  /** Static capability profile (#618). Absent: nothing is disabled. */
  readonly capabilityProfile?: ChargePointCapabilityProfile;
  /** OCPP 1.6J only. Default `warn`. */
  readonly inboundValidation?: InboundValidationMode;
  readonly centralSystemUrl?: string;
  readonly soapCallbackUrl?: string;
  readonly soapPath?: string;
  readonly soapRequestTimeoutMs?: number;
  /**
   * Every supervision URL this charge point may use, when it was given more
   * than one. `wsUrl` stays the first of them, so everything that reports or
   * persists a URL keeps seeing one string; the pool picks per attempt.
   * OCPP-J only — SOAP has no reconnect loop to rotate.
   */
  readonly supervisionUrls?: readonly string[];
  readonly urlDistribution?: UrlDistribution;
  /**
   * #609: reconnect policy and BootNotification retry limit. Omitted fields
   * keep {@link DEFAULT_RECONNECT_POLICY}, which is the behaviour before the
   * policy was configurable. OCPP-J only for the reconnect part; the boot
   * retry limit applies to every transport.
   */
  readonly reconnect?: Partial<ReconnectPolicy>;
  /**
   * #611: WebSocket client options (handshake timeout, compression, max
   * payload, proxy, local address). OCPP-J only. The constructor throws
   * `UnsupportedWsOptionError` for an option this runtime would ignore.
   */
  readonly ws?: WsClientOptions;
  /** Resolved idTags this charge point draws from (#299). */
  readonly idTags?: readonly string[];
  readonly idTagDistribution?: IdTagDistribution;
  /**
   * OCPP 1.6 ReserveNow: authorize the reservation's idTag (local rules, then
   * Authorize.req) before accepting; a tag that is not `Accepted` answers
   * `Rejected` (#595). Default `false`.
   */
  readonly reservationAuthorizeIdTag?: boolean;
  /**
   * #1133: the decimal separator of every OCPP 1.6 `SampledValue.value` the
   * station sends (JSON and SOAP). Default `"."`; `","` is refused on any
   * other version (the constructor throws).
   */
  readonly meterValueDecimalSeparator?: MeterValueDecimalSeparator;
  /**
   * #1134: the periodic and clock-aligned samples of a running transaction go
   * out with an empty `sampledValue` list. Deliberately non-conformant
   * (`minItems: 1`); the frame is sent and the outbound schema warning logged.
   * Default `false`.
   */
  readonly emptyMeterValues?: boolean;
}
