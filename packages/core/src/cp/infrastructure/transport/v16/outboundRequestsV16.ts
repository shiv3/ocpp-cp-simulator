// OCPP 1.6 outbound CALLs as the §4.1.1 serial queue tracks them: the
// entries, the request history and the predicates the delivery shares
// with OCPPMessageHandler (#877).
import { isCriticalSecurityEvent16 } from "../../../domain/security/securityEvents16";
import type { MeterValuesRequestV16 } from "@ocpp-cp-simulator/ocpp/index";
import type {
  OcppMessagePayload,
  OcppMessageRequestPayload,
} from "../OCPPWebSocket";
import {
  OCPPAction,
  type OCPPMessageType,
} from "../../../domain/types/OcppTypes";

/** Actions the 1.6 handler queues offline and replays (§4.7 / §4.8 /
 *  §4.10). Any other row in `pending_messages` was queued by the 2.x
 *  handler under the same charge point id: the queue deletes it on load
 *  (#528). */
export const QUEUED_ON_OCPP16: ReadonlySet<OCPPAction> = new Set([
  OCPPAction.StartTransaction,
  OCPPAction.StopTransaction,
  OCPPAction.MeterValues,
]);

export interface OCPPRequest {
  type: OCPPMessageType;
  action: OCPPAction;
  id: string;
  payload: OcppMessagePayload;
  connectorId?: number | null;
  /** #527: the 1-based transmission of a transaction-related message the
   *  station resends after a CALLERROR (§3.7.1). Absent on every other CALL,
   *  expert calls included. */
  attempt?: number;
  /** #565: the StartTransaction.req this StopTransaction.req or MeterValues.req
   *  belongs to, to give it the id that request got (or `-1`) when it is sent. */
  startRef?: StartRef;
  /** #527: its 30 s watchdog expired. A later CALLRESULT still applies, but a
   *  CALLERROR no longer counts as a failed transmission: 1.6 does not retry
   *  a timeout, and the station already gave up on this one. */
  timedOut?: boolean;
}

/**
 * Predicate for "is this CALL a transaction-related message that must be
 * queued on offline" (§4.7/§4.8/§4.10). MeterValues without a transaction
 * id are informational and intentionally NOT queued — see §4.7.
 */
export function isTransactionRelated(action: OCPPAction): boolean {
  return QUEUED_ON_OCPP16.has(action);
}

/** A04.FR.02 (#734): a critical SecurityEventNotification the station keeps
 *  while it cannot send it. */
export function isCriticalSecurityEventCall(entry: {
  action: OCPPAction;
  payload: unknown;
}): boolean {
  return (
    entry.action === OCPPAction.SecurityEventNotification &&
    isCriticalSecurityEvent16((entry.payload as { type?: string }).type ?? "")
  );
}

/**
 * #527, Part 2 §3.7.1: the CALLs whose CALLERROR is retried, then discarded —
 * StartTransaction.req, StopTransaction.req and a MeterValues.req of a
 * transaction. A CALL whose caller waits for its answer (an expert call) is
 * that caller's, and never resent.
 */
export function isRetriedOnCallError(
  entry: Pick<SerialEntry, "action" | "payload" | "onDropped">,
): boolean {
  if (entry.onDropped || !isTransactionRelated(entry.action)) return false;
  return (
    entry.action !== OCPPAction.MeterValues ||
    (entry.payload as MeterValuesRequestV16).transactionId !== undefined
  );
}

/**
 * The connector a StartTransaction.req, StopTransaction.req or MeterValues.req
 * concerns, for both its CALLRESULT and its CALLERROR: the one it was sent
 * for, else the one its payload names (a row of the offline queue can have no
 * `connector_id`), else 1.
 */
export function requestConnectorId(request: {
  connectorId?: number | null;
  payload: unknown;
}): number {
  const { connectorId } = request.payload as { connectorId?: number };
  return request.connectorId ?? connectorId ?? 1;
}

export class RequestHistory {
  private _currentId: string = "";
  private _requests: Map<string, OCPPRequest> = new Map();

  public add(request: OCPPRequest): void {
    this._currentId = request.id;
    this._requests.set(request.id, request);
  }

  public current(): OCPPRequest | undefined {
    return this._requests.get(this._currentId);
  }

  public get(id: string): OCPPRequest | undefined {
    return this._requests.get(id);
  }

  public remove(id: string): void {
    this._requests.delete(id);
  }
}

/** A CALL waiting for, or holding, the §4.1.1 serialization slot. */
/** #565: identifies the StartTransaction.req of a transaction: its `idTag`
 *  and `timestamp` (the pair `isRunningTransactionStartedBy` matches) on its
 *  connector: the start time is unique per connector only. */
export interface StartRef {
  connectorId: number;
  idTag: string;
  startedAt: string;
}

export function startKey(ref: StartRef): string {
  return `${ref.connectorId}\u0000${ref.idTag}\u0000${ref.startedAt}`;
}

/** The OCPP 1.6 Part 2 errata (3.18) id for a transaction whose
 *  StartTransaction.req was discarded. */
export const UNKNOWN_TRANSACTION_ID = -1;

export interface SerialEntry {
  action: OCPPAction;
  id: string;
  /** The payload as the station built it. It is what the request history
   *  keeps (so an answer is matched against the CALL as it was meant), what
   *  the offline queue stores and what a resend starts from. */
  payload: OcppMessageRequestPayload;
  /** What the behaviors' beforeSend made of it, when they changed it: the
   *  payload written to the socket. */
  wire?: OcppMessageRequestPayload;
  connectorId?: number;
  /** A caller waits for this CALL's answer: when it is dropped the caller
   *  is told, instead of the CALL being salvaged or silently discarded. */
  onDropped?: (reason: string) => void;
  /** #527: the 1-based transmission this is; 1 unless it is a resend. */
  attempt?: number;
  /** #527: the CALLERROR that caused this resend, for its discard notice. */
  lastErrorCode?: string;
  /** #565: see {@link OCPPRequest.startRef}. */
  startRef?: StartRef;
  /** #565: the behaviors' beforeSend already ran for this transmission (its
   *  `wire` is what they made of it). A held entry that was intercepted goes
   *  back to the serial queue as it is: one transmission, one interception. */
  intercepted?: boolean;
}
