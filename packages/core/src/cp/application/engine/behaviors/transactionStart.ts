// Starting a transaction (the default transaction behavior), split out of
// transaction.ts (#877).
import type {
  ChargePoint,
  StartTransactionOptions,
  StartTransactionOutcome,
} from "../../../domain/charge-point/ChargePoint";
import type { Connector } from "../../../domain/connector/Connector";
import type { Transaction } from "../../../domain/connector/Transaction";
import { startChargingStateOf } from "../../../domain/connector/EvConnection";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import type { TransactionPorts } from "../../../domain/engine/ChargePointEngine";
import { LogType } from "../../../shared/Logger";
import { startRefusalByReservation } from "../../../domain/reservation/reservationModel";
import { reservationAdmits } from "../../../domain/reservation/Reservation";
import { nowDate, startsInProgress } from "./transactionStop";

/**
 * Whether `tagId` is a stranger to a reservation that concerns `connectorId`
 * but could still belong to its group: the reservation names a parent idTag /
 * groupIdToken and the station does not know the tag's own (H03.FR.07/08).
 */
export function mayMatchThroughParent(
  cp: ChargePoint,
  connectorId: number,
  tagId: string,
): boolean {
  if (cp.knownParentIdOf(tagId) !== undefined) return false;
  return cp.reservationManager
    .getAllReservations()
    .some(
      (r) =>
        (r.connectorId === connectorId || r.connectorId === 0) &&
        r.parentIdTag !== undefined &&
        !reservationAdmits(r, tagId),
    );
}

export async function startTransaction(
  cp: ChargePoint,
  ports: TransactionPorts,
  tagId: string,
  connectorId: number,
  batteryCapacityKwh?: number,
  initialSoc?: number,
  options: StartTransactionOptions = {},
): Promise<StartTransactionOutcome> {
  const logger = cp.logger;
  const connector = cp.getConnector(connectorId);
  if (!connector) {
    logger.error(`Connector ${connectorId} not found`, LogType.TRANSACTION);
    return { started: false };
  }

  if (connector.transaction && connector.transaction.stopTime === null) {
    if (
      connector.transaction.awaitingAuthorization &&
      options.awaitAuthorization !== true
    ) {
      return authorizeAwaitingTransaction(cp, connector, tagId, options);
    }
    // Only a NOT-yet-stopped transaction blocks a new start. A closed one
    // still attached (cleanTransaction sets stopTime without detaching; a
    // snapshot persisted before #491 restores one) must NOT block a retry.
    logger.warn(
      `Connector ${connectorId} already has an active transaction; ignoring duplicate start`,
      LogType.TRANSACTION,
    );
    return { started: false };
  }

  // #697: TxStartPoint without Authorized (EVConnected alone): the
  // authorization does not start the transaction, the plug-in does. The
  // token is authorized now and held until the cable is in.
  if (
    isOcpp2Version(cp.ocppVersion) &&
    options.awaitAuthorization !== true &&
    options.preAuthorized !== true &&
    connector.availability === "Operative" &&
    connector.evConnection === "disconnected" &&
    !cp.configuration.txStartPoint().includes("Authorized")
  ) {
    if (
      options.triggerReason !== "RemoteStart" &&
      options.idTokenType !== "NoAuthorization" &&
      cp.configuration.authorizeBeforeLocalStart()
    ) {
      const status = await cp.authorizeAndWait(
        tagId,
        undefined,
        options.idTokenType,
      );
      if (status !== "Accepted") {
        logger.warn(
          `Authorize.conf ${status} for ${tagId}; refusing local transaction start on connector ${connectorId}`,
          LogType.TRANSACTION,
        );
        cp.events.emit("authorizeDenied", { connectorId, tagId, status });
        return { started: false, denialStatus: status };
      }
    }
    logger.info(
      `TxStartPoint is EVConnected: ${tagId} is authorized; the transaction on connector ${connectorId} starts at the plug-in`,
      LogType.TRANSACTION,
    );
    cp.deferStartUntilPlugIn(connectorId, tagId, options);
    return { started: false };
  }

  if (connector.availability !== "Operative") {
    logger.warn(
      `Connector ${connectorId} is ${connector.availability}; refusing to start transaction`,
      LogType.TRANSACTION,
    );
    return { started: false };
  }

  // Issue #181: gate LOCAL (non-remote-start) starts on Authorize.conf.
  // "RemoteStart" means either the remote start default (which already
  // applies AuthorizeRemoteTxRequests semantics) or a scenario that captured
  // a RemoteStartTrigger node: both already went through CSMS-driven
  // authorization, so they're excluded here.
  const isLocalStart = options.triggerReason !== "RemoteStart";
  // NoAuthorization has no token to authorize (IdTokenEnumType, #599).
  const authorizedBeforeStart =
    options.awaitAuthorization !== true &&
    isLocalStart &&
    options.idTokenType !== "NoAuthorization" &&
    cp.configuration.authorizeBeforeLocalStart();
  if (authorizedBeforeStart) {
    const status = await cp.authorizeAndWait(
      tagId,
      undefined,
      options.idTokenType,
    );
    // Any non-"Accepted" status denies the local start. Deliberately NOT an
    // allowlist of denial strings: 2.x has more denial values than 1.6.
    if (status !== "Accepted") {
      logger.warn(
        `Authorize.conf ${status} for ${tagId}; refusing local transaction start on connector ${connectorId}`,
        LogType.TRANSACTION,
      );
      cp.events.emit("authorizeDenied", { connectorId, tagId, status });
      return { started: false, denialStatus: status };
    }
  }

  // A reservation holds its connector for its own tag (1.6 §5.13: the station
  // "SHALL refuse charging for all incoming idTags on the reserved connector"
  // but the reserved one, or one with the same parent idTag; 2.0.1 H03.FR.01/04:
  // the idToken or its groupIdToken). The parent is what the station knows
  // (Local Authorization List, Authorization Cache, a previous Authorize.conf);
  // a local start whose tag may still match through a parent asks the CSMS for
  // it (H03.FR.08). Checked after the Authorize gate, where an expired
  // reservation is dropped as before. A refused start sends nothing and leaves
  // the reservation and the connector's Reserved status alone (#721, #711).
  // A connector-0 reservation of another tag keeps one connector free for its
  // whole validity (the capacity rule); that session is refused the same way.
  if (
    isLocalStart &&
    !authorizedBeforeStart &&
    options.awaitAuthorization !== true &&
    mayMatchThroughParent(cp, connectorId, tagId)
  ) {
    await cp.authorizeAndWait(tagId);
  }
  // The group the request named is what decided to accept it (F01.FR.21/22);
  // the station may not know the token's own.
  const parentOfTag = options.groupIdToken ?? cp.knownParentIdOf(tagId);
  const refusal = startRefusalByReservation(
    cp,
    connectorId,
    tagId,
    parentOfTag,
  );
  if (refusal !== null) {
    logger.warn(
      refusal === "reservedForOther"
        ? `Refusing transaction start for ${tagId} on connector ${connectorId}: it is reserved for another idTag (OCPP 1.6 §5.13, 2.0.1 H03.FR.09)`
        : `Refusing transaction start for ${tagId} on connector ${connectorId}: it would leave no connector for a reservation (OCPP 1.6 §5.13, 2.0.1 H01.FR.07)`,
      LogType.TRANSACTION,
    );
    return { started: false };
  }

  // §5.13: if the connector was Reserved for this tag (or the reservation is
  // for connectorId=0 with this idTag), consume that reservation and carry
  // its id into StartTransaction.req / TransactionEvent(Started) so CSMS can
  // close it out. A connector-0 reservation belongs to its idTag /
  // parentIdTag only (#595).
  const reservation = cp.reservationManager.reservationFor(
    connectorId,
    tagId,
    parentOfTag,
  );
  const reservationId = reservation?.reservationId;
  const evConnection = connector.evConnection;
  const ocpp2 = isOcpp2Version(cp.ocppVersion);

  const transaction: Transaction = {
    id: 0,
    connectorId,
    tagId,
    meterStart: connector.meterValue,
    meterStop: null,
    startTime: isOcpp2Version(cp.ocppVersion)
      ? nowDate(cp)
      : connector.nextStartTime(nowDate(cp)),
    stopTime: null,
    meterSent: false,
    reservationId,
    remoteStartId: options.remoteStartId,
    ...(options.idTokenType !== undefined
      ? { idTokenType: options.idTokenType }
      : {}),
    startTriggerReason: options.triggerReason,
    // #846: without an explicit state, the cable decides (Idle before it is in).
    startChargingState:
      options.chargingState ??
      (ocpp2 ? startChargingStateOf(evConnection) : undefined),
    ...(options.awaitAuthorization === true
      ? { awaitingAuthorization: true }
      : {}),
    // #727: the `0` id is a placeholder until StartTransaction.conf (1.x).
    ...(isOcpp2Version(cp.ocppVersion) ? {} : { startUnanswered: true }),
    batteryCapacityKwh,
    initialSoc,
    ...(options.targetSoc !== undefined
      ? { targetSoc: options.targetSoc }
      : {}),
    ...(options.stopAtTarget !== undefined
      ? { stopAtTarget: options.stopAtTarget }
      : {}),
  };

  if (initialSoc !== undefined) {
    connector.soc = initialSoc;
  }

  if (reservation) {
    // The reservation is fulfilled the moment we send StartTransaction
    // (§5.13).
    cp.reservationManager.cancelReservation(reservation.reservationId);
  }

  const cablePluggedBefore = evConnection !== "disconnected";
  connector.beginTransaction(transaction);
  // 2.x idToken-first (E03): a transaction started before the cable is in does
  // not put one there. The plug-in that follows is a cable event of its own
  // (Updated CablePluggedIn / EVConnected) and stops EVConnectionTimeOut.
  if (isOcpp2Version(cp.ocppVersion) && !cablePluggedBefore) {
    connector.markEvUnplugged();
  }
  // From here on the transaction is the connector's live view, so that what
  // the outbox stamps on it (2.x ids, seqNo) lands in the engine state.
  const live = connector.transaction ?? transaction;
  // Drive Preparing before enqueueing StartTransaction.req: the outbound CALL
  // queue is strictly serial, so whichever is queued first is what the wire
  // sees first (#176). A connector already in Preparing has sent it: a second
  // StatusNotification(Preparing) is a transition OCPP 1.6 does not have
  // (#496); its ConnectionTimeOut restarts (#527).
  // #727, 1.6 Part 2 §3.7: a stop requested by a listener of the Preparing
  // status (before this function queued the StartTransaction.req) waits for
  // the start, so that the StopTransaction.req follows it with the id its
  // conf assigns, in the order the messages came about.
  const deferredStops: Array<() => void> = [];
  const deferStops = !isOcpp2Version(cp.ocppVersion);
  if (deferStops) startsInProgress.set(connector, deferredStops);
  let queued = false;
  try {
    if (connector.status === OCPPStatus.Preparing) {
      ports.startConnectionTimeout(connectorId);
    } else {
      cp.updateConnectorStatus(connectorId, OCPPStatus.Preparing);
    }
    ports.sendTransactionEvent({
      phase: "started",
      transaction: live,
      connectorId,
    });
    queued = true;
  } finally {
    if (deferStops) startsInProgress.delete(connector);
    // A listener or the send threw: the stops requested meanwhile are not
    // lost with the exception. They run now, on the transaction as it is
    // (the original error still propagates).
    if (!queued) {
      for (const stop of deferredStops) {
        try {
          stop();
        } catch (error) {
          cp.logger.error(
            `Deferred stop of connector ${connectorId} failed: ${String(error)}`,
            LogType.TRANSACTION,
          );
        }
      }
    }
  }
  // 2.x: the Started event already said SuspendedEV (1.6 waits for the conf).
  // A state the caller named (#335) is wire only: the EV decides the hold.
  if (
    ocpp2 &&
    evConnection === "connected-not-ready" &&
    live.startChargingState === "SuspendedEV"
  ) {
    holdForNotReadyEv(cp, connector);
  }

  cp.events.emit("transactionStarted", {
    connectorId,
    transactionId: 0,
    tagId,
  });
  for (const stop of deferredStops) stop();

  return { started: true };
}

/**
 * #697: the idToken of a transaction the cable started (`TxStartPoint`
 * `EVConnected`). A local one is authorized first, as a local start is; a
 * denial leaves the transaction waiting. Then the transaction takes the
 * token and reports it in an Updated event (triggerReason `Authorized`, or
 * `RemoteStart` with the request's remoteStartId), and the energy starts.
 */
async function authorizeAwaitingTransaction(
  cp: ChargePoint,
  connector: Connector,
  tagId: string,
  options: StartTransactionOptions,
): Promise<StartTransactionOutcome> {
  const remote = options.triggerReason === "RemoteStart";
  if (
    !remote &&
    options.preAuthorized !== true &&
    options.idTokenType !== "NoAuthorization" &&
    cp.configuration.authorizeBeforeLocalStart()
  ) {
    const status = await cp.authorizeAndWait(
      tagId,
      undefined,
      options.idTokenType,
    );
    if (status !== "Accepted") {
      cp.logger.warn(
        `Authorize.conf ${status} for ${tagId}; the transaction on connector ${connector.id} keeps waiting for an idToken`,
        LogType.TRANSACTION,
      );
      cp.events.emit("authorizeDenied", {
        connectorId: connector.id,
        tagId,
        status,
      });
      return { started: false, denialStatus: status };
    }
  }
  // The wait for the Authorize may have outlived the transaction.
  const live = connector.transaction;
  if (!live || live.stopTime !== null || !live.awaitingAuthorization) {
    return { started: false };
  }
  connector.patchTransaction({
    tagId,
    awaitingAuthorization: false,
    ...(options.idTokenType !== undefined
      ? { idTokenType: options.idTokenType }
      : {}),
    ...(options.remoteStartId !== undefined
      ? { remoteStartId: options.remoteStartId }
      : {}),
  });
  const evNotReady = connector.evConnection === "connected-not-ready";
  cp.sendTransactionUpdate(connector.id, {
    triggerReason: remote ? "RemoteStart" : "Authorized",
    chargingState: evNotReady ? "SuspendedEV" : "Charging",
    idToken: {
      tagId,
      ...(options.idTokenType !== undefined
        ? { type: options.idTokenType }
        : {}),
    },
    ...(options.remoteStartId !== undefined
      ? { remoteStartId: options.remoteStartId }
      : {}),
  });
  if (evNotReady) holdForNotReadyEv(cp, connector);
  else if (connector.status === OCPPStatus.Preparing) {
    cp.updateConnectorStatus(connector.id, OCPPStatus.Charging);
  }
  cp.events.emit("transactionStarted", {
    connectorId: connector.id,
    transactionId: 0,
    tagId,
  });
  return { started: true };
}

/**
 * #871: a transaction that starts for an EV not asking for energy goes
 * straight to `SuspendedEV` (1.6 §4.9 B4: "All prerequisites for charging
 * are met but EV does not start charging"), never `Charging` first. The
 * offer is held as `evSetReady(false)` holds it, so that the EV's readiness
 * resumes `Charging`.
 */
function holdForNotReadyEv(cp: ChargePoint, connector: Connector): void {
  connector.suspendEnergyOffer();
  if (connector.status !== OCPPStatus.SuspendedEV) {
    cp.updateConnectorStatus(connector.id, OCPPStatus.SuspendedEV);
  }
}
