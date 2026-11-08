import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import type {
  ChargePoint,
  StartTransactionOptions,
  StartTransactionOutcome,
  StopTransactionOptions,
} from "../../../domain/charge-point/ChargePoint";
import type { Connector } from "../../../domain/connector/Connector";
import type {
  StopTransactionReason,
  IdTokenTypeName,
  Transaction,
} from "../../../domain/connector/Transaction";
import {
  ChargingProfilePurposeType,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import { LogType } from "../../../shared/Logger";
import { startRefusalByReservation } from "../../../domain/reservation/reservationModel";
import { reservationAdmits } from "../../../domain/reservation/Reservation";
import { decideRemoteStart } from "./remoteStartValidation";

/**
 * What the transaction defaults need from the station beyond its public API.
 * `ChargePoint` builds one and hands it to the engine.
 */
export interface TransactionPorts {
  /** Hand a transaction phase to the protocol encoder. */
  sendTransactionEvent(event: {
    phase: "started" | "ended";
    transaction: Transaction;
    connectorId: number;
  }): void;
  /** (Re)start the ConnectionTimeOut of a connector that is in Preparing. */
  startConnectionTimeout(connectorId: number): void;
}

/**
 * The default behavior of a transaction (docs/concepts/charger-engine.md,
 * "Charger engine"): starting and stopping one, and the four remote
 * actions of both OCPP versions, written once. The adapters only translate.
 *
 * `start` / `stop` are the former `ChargePoint.startTransaction` /
 * `stopTransaction` / `cleanTransaction`; they write the transaction of a
 * connector through the engine (`connector.patchTransaction`,
 * `beginTransaction`, `stopTransaction`). Meter value calculation and
 * charging profile resolution stay as services (`Connector`,
 * `clearChargingProfiles`).
 *
 * Remote start and stop keep the scenario delegation: a connector a
 * scenario `RemoteStartTrigger` / `RemoteStopTrigger` node is parked on gets
 * the request through `remoteStartReceived` / `remoteStopReceived` instead.
 * That registry (`registerScenarioHandler` and friends, and the
 * `noteDefaultHandled…` race marks) stays in `ChargePoint`: the scenario
 * runtime arms and reads it, and a scenario rule of the behavior registry
 * does not replace it without changing the traffic of existing scenarios
 * (see the design doc, stage C2).
 */
export function transactionBehavior(cp: ChargePoint): Behavior {
  return {
    api: 1,
    id: "default.transaction",
    onCall: {
      RemoteStartTransaction: {
        mode: "replace",
        handle: (request) => {
          const { idTag, connectorId } = request as {
            idTag: string;
            connectorId?: number;
          };
          // 1.6 §5.11 (errata 3.32): `Accepted` means a start will be
          // attempted. A named connector must be able to start; without one
          // the lowest connector that can start is used.
          const resolved = connectorId
            ? remoteStartable(cp, connectorId, idTag)
              ? connectorId
              : undefined
            : [...cp.connectors.keys()]
                .filter((id) => id > 0)
                .sort((a, b) => a - b)
                .find((id) => remoteStartable(cp, id, idTag));
          if (resolved === undefined) {
            return { response: { status: "Rejected" } };
          }
          // 1.6 §5.11: the transaction starts while the answer is built.
          void remoteStart(cp, resolved, idTag, undefined);
          return { response: { status: "Accepted" } };
        },
      },
      RemoteStopTransaction: {
        mode: "replace",
        handle: (request) => {
          const { transactionId } = request as { transactionId: number };
          // #491, #527: a transaction whose StartTransaction.req was answered
          // with a CALLERROR runs on the `0` placeholder the CSMS never
          // issued; a request naming it is not about this transaction, and
          // neither is one naming a placeholder the CSMS never answered
          // (`startUnanswered`, #727). A `0` the CSMS assigned is (#328).
          const connector = Array.from(cp.connectors.values()).find(
            (c) =>
              c.transaction &&
              c.transaction.id === transactionId &&
              !c.transaction.startCallError &&
              !c.transaction.startUnanswered,
          );
          if (!connector) return { response: { status: "Rejected" } };
          if (cp.isScenarioStopHandled(connector.id)) {
            // The scenario's own Transaction Stop step runs the §7.36 path.
            cp.notifyRemoteStopReceived(connector.id, transactionId);
            return { response: { status: "Accepted" } };
          }
          cp.noteDefaultHandledRemoteStop(connector.id);
          cp.updateConnectorStatus(connector.id, OCPPStatus.SuspendedEVSE);
          // §7.36: reason "Remote".
          cp.stopTransaction(connector, "Remote");
          return { response: { status: "Accepted" } };
        },
      },
      RequestStartTransaction: {
        mode: "replace",
        handle: (request) => {
          const req = request as {
            evseId?: number;
            remoteStartId: number;
            idToken: { idToken: string; type?: string };
            groupIdToken?: { idToken: string };
          };
          const decision = decideRemoteStart(cp, req);
          if (!decision.ok) return { response: decision.rejection };
          const connectorId = decision.connectorId;
          return {
            response: { status: "Accepted" },
            after: async () => {
              await remoteStart(
                cp,
                connectorId,
                req.idToken.idToken,
                req.remoteStartId,
                requestIdTokenType(req.idToken.type),
                req.groupIdToken?.idToken,
              );
            },
          };
        },
      },
      RequestStopTransaction: {
        mode: "replace",
        handle: (request) => {
          const req = request as { transactionId: string };
          const connector = Array.from(cp.connectors.values()).find(
            (candidate) =>
              candidate.transaction?.cpTransactionId === req.transactionId,
          );
          if (!connector) return { response: { status: "Rejected" } };
          const txId = connector.transaction?.id ?? 0;
          return {
            response: { status: "Accepted" },
            after: async () => {
              if (cp.isScenarioStopHandled(connector.id)) {
                cp.notifyRemoteStopReceived(connector.id, txId);
              } else {
                cp.noteDefaultHandledRemoteStop(connector.id);
                cp.stopTransaction(connector.id, "Remote", {
                  triggerReason: "RemoteStop",
                });
              }
            },
          };
        },
      },
    },
  };
}

/**
 * Whether a remote start for `idTag` can be attempted on the connector (1.6
 * §5.11, errata 3.32): known, Operative, not Faulted, no running transaction,
 * not reserved for another tag (§5.13, H03.FR.09: the tag or its parent id /
 * groupIdToken, as the station knows it) and not the last connector a
 * reservation without a connector keeps for its owner (§5.13, H01.FR.07).
 */
function remoteStartable(
  cp: ChargePoint,
  connectorId: number,
  idTag: string,
): boolean {
  const connector = cp.getConnector(connectorId);
  if (!connector || connector.availability !== "Operative") return false;
  if (connector.status === OCPPStatus.Faulted) return false;
  if (connector.hasRunningTransaction) return false;
  return (
    startRefusalByReservation(
      cp,
      connectorId,
      idTag,
      cp.knownParentIdOf(idTag),
    ) === null
  );
}

/**
 * The start of a remote start on either version (1.6 §5.11, 2.x F01).
 *
 * 1.6: `AuthorizeRemoteTxRequests` asks for an Authorize.req alongside the
 * start. 2.x (F01.FR.01/02): with `AuthorizeRemoteStart` true and an
 * `idToken.type` other than `Central` / `NoAuthorization` the station behaves
 * as for a local action and starts only after the authorization (local list,
 * cache or Authorize.req) is `Accepted`; otherwise it starts without checking
 * and sends no Authorize. The RequestStartTransaction answer has gone out
 * before this runs. A scenario waiting on the connector gets the request
 * (with the Authorize sent alongside, as before); otherwise the default
 * starts the transaction with `triggerReason: "RemoteStart"` (so the local
 * authorize gate does not authorize twice).
 */
async function remoteStart(
  cp: ChargePoint,
  connectorId: number,
  idTag: string,
  remoteStartId: number | undefined,
  idTokenType?: IdTokenTypeName,
  groupIdToken?: string,
): Promise<void> {
  const ocpp2 = isOcpp2Version(cp.ocppVersion);
  const centrallyAuthorized =
    idTokenType === "Central" || idTokenType === "NoAuthorization";
  if (cp.configuration.authorizeRemoteTxRequests() && !centrallyAuthorized) {
    if (!ocpp2) {
      cp.logger.info(
        `AuthorizeRemoteTxRequests=true: sending Authorize.req for ${idTag}`,
        LogType.OCPP,
      );
    }
    if (ocpp2 && !cp.isScenarioHandled(connectorId)) {
      const status = await cp.authorizeAndWait(idTag, undefined, idTokenType, {
        failClosed: true,
      });
      if (status !== "Accepted") {
        cp.logger.warn(
          `Authorize.conf ${status} for ${idTag}; not starting the remote transaction on connector ${connectorId} (F01.FR.01)`,
          LogType.TRANSACTION,
        );
        cp.events.emit("authorizeDenied", {
          connectorId,
          tagId: idTag,
          status,
        });
        return;
      }
    } else {
      cp.authorize(idTag, idTokenType);
    }
  }
  if (cp.isScenarioHandled(connectorId)) {
    cp.notifyRemoteStartReceived(
      connectorId,
      idTag,
      remoteStartId,
      idTokenType,
    );
    return;
  }
  // Note it so a scenario that arms on this connector shortly after can tell
  // it raced this exact call (ScenarioRuntime.waitForRemoteStart).
  cp.noteDefaultHandledRemoteStart(connectorId);
  void cp.startTransaction(idTag, connectorId, undefined, undefined, {
    triggerReason: "RemoteStart",
    ...(remoteStartId !== undefined ? { remoteStartId } : {}),
    ...(idTokenType !== undefined ? { idTokenType } : {}),
    ...(groupIdToken !== undefined ? { groupIdToken } : {}),
  });
}

/**
 * The `idToken.type` of a RequestStartTransaction (#599, F01.FR.04: the
 * Charging Station SHALL use the request's IdToken in the TransactionEvent).
 * The CALL schema already holds it to `IdTokenEnumType` on 2.0.1; on 2.1 it is
 * a free string of at most 20 characters (IdTokenEnumStringType is only the
 * list of standard values), so it is carried as sent.
 */
function requestIdTokenType(
  type: string | undefined,
): IdTokenTypeName | undefined {
  return type ? (type as IdTokenTypeName) : undefined;
}

const nowDate = (cp: ChargePoint): Date => new Date(cp.clock.now());

/**
 * Whether `tagId` is a stranger to a reservation that concerns `connectorId`
 * but could still belong to its group: the reservation names a parent idTag /
 * groupIdToken and the station does not know the tag's own (H03.FR.07/08).
 */
function mayMatchThroughParent(
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
    // Only a NOT-yet-stopped transaction blocks a new start. A closed one
    // still attached (cleanTransaction sets stopTime without detaching; a
    // snapshot persisted before #491 restores one) must NOT block a retry.
    logger.warn(
      `Connector ${connectorId} already has an active transaction; ignoring duplicate start`,
      LogType.TRANSACTION,
    );
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
    startChargingState: options.chargingState,
    // #727: the `0` id is a placeholder until StartTransaction.conf (1.x).
    ...(isOcpp2Version(cp.ocppVersion) ? {} : { startUnanswered: true }),
    batteryCapacityKwh,
    initialSoc,
  };

  if (initialSoc !== undefined) {
    connector.soc = initialSoc;
  }

  if (reservation) {
    // The reservation is fulfilled the moment we send StartTransaction
    // (§5.13).
    cp.reservationManager.cancelReservation(reservation.reservationId);
  }

  connector.beginTransaction(transaction);
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
  } finally {
    if (deferStops) startsInProgress.delete(connector);
  }

  cp.events.emit("transactionStarted", {
    connectorId,
    transactionId: 0,
    tagId,
  });
  for (const stop of deferredStops) stop();

  return { started: true };
}

/** #727: connectors whose StartTransaction.req (1.x) is not queued yet, with
 *  the stops requested meanwhile. */
const startsInProgress = new WeakMap<Connector, Array<() => void>>();

export function stopTransaction(
  cp: ChargePoint,
  ports: TransactionPorts,
  connectorOrId: number | Connector,
  reason?: StopTransactionReason,
  options: StopTransactionOptions = {},
): void {
  const logger = cp.logger;
  const connector =
    typeof connectorOrId === "number"
      ? cp.getConnector(connectorOrId)
      : connectorOrId;
  if (!connector) {
    const connId =
      typeof connectorOrId === "number" ? connectorOrId : connectorOrId.id;
    logger.error(`Connector ${connId} not found`, LogType.TRANSACTION);
    return;
  }

  const waitingForStart = startsInProgress.get(connector);
  if (waitingForStart) {
    waitingForStart.push(() =>
      stopTransaction(cp, ports, connector, reason, options),
    );
    return;
  }

  const transaction = connector.transaction;
  // A closed transaction (`stopTime` set) is no transaction: stopping it again
  // would send a second StopTransaction.req for it (#491).
  if (!transaction || !connector.hasRunningTransaction) {
    logger.warn(
      `No active transaction for connector ${connector.id} when stopping`,
      LogType.TRANSACTION,
    );
    return;
  }

  connector.stopAutoMeterValue();
  connector.patchTransaction({
    stopTime: options.stoppedAt ?? nowDate(cp),
    meterStop: connector.meterValue,
    ...(reason ? { stopReason: reason } : {}),
    ...(options.triggerReason
      ? { stopTriggerReason: options.triggerReason }
      : {}),
    ...(options.stoppedReason ? { stoppedReason: options.stoppedReason } : {}),
  });

  ports.sendTransactionEvent({
    phase: "ended",
    transaction,
    connectorId: connector.id,
  });

  cp.events.emit("transactionStopped", {
    connectorId: connector.id,
    transactionId: transaction.id,
    reason: transaction.stoppedReason ?? transaction.stopReason,
  });

  // Clear TxProfile charging profiles when the transaction ends (OCPP 1.6).
  // Only TxProfile: TxDefaultProfile and ChargePointMaxProfile persist.
  const [cleared] = cp.clearChargingProfiles(
    connector.id,
    { purpose: ChargingProfilePurposeType.TxProfile },
    "TransactionEnded",
  );
  if (cleared) {
    logger.info(
      `Cleared ${cleared.profiles.length} TxProfile(s) after transaction end on connector ${connector.id}`,
      LogType.TRANSACTION,
    );
  }

  cleanTransaction(cp, connector);
  connector.stopTransaction();
  if (connector.autoResetToAvailable) {
    cp.updateConnectorStatus(connector.id, OCPPStatus.Available);
  }

  // §5.2: if ChangeAvailability arrived while this transaction was running we
  // returned `Scheduled`; now that it stopped, finalize the deferred
  // availability flip and fire the follow-up StatusNotification.
  const scheduled = connector.scheduledAvailability;
  if (scheduled && scheduled !== connector.availability) {
    cp.engine.dispatch({
      type: "connector.write",
      connectorId: connector.id,
      write: { kind: "availability", availability: scheduled },
    });
    cp.updateConnectorStatus(
      connector.id,
      scheduled === "Operative" ? OCPPStatus.Available : OCPPStatus.Unavailable,
    );
    cp.persistAvailability();
  }
  cp.engine.dispatch({
    type: "connector.write",
    connectorId: connector.id,
    write: { kind: "scheduledAvailability", value: null },
  });

  // #597: a Reset OnIdle answered `Scheduled` boots once its last targeted
  // transaction ends.
  cp.runPendingResetOnIdle();
}

export function cleanTransaction(
  cp: ChargePoint,
  connectorOrId: Connector | number,
): void {
  const connector =
    typeof connectorOrId === "number"
      ? cp.getConnector(connectorOrId)
      : connectorOrId;
  if (!connector) return;

  if (connector.transaction) {
    connector.patchTransaction({
      meterSent: false,
      stopTime: nowDate(cp),
      meterStop: connector.meterValue,
    });
    // Emit Finishing state for scenarios that rely on the transitional status.
    cp.updateConnectorStatus(connector.id, OCPPStatus.Finishing);
  }

  connector.stopAutoMeterValue();
}
