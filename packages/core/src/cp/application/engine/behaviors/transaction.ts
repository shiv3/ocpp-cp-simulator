import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import type {
  ChargePoint,
  StartTransactionOptions,
  StartTransactionOutcome,
  StopTransactionOptions,
} from "../../../domain/charge-point/ChargePoint";
import type { Connector } from "../../../domain/connector/Connector";
import type {
  StopTransactionReason,
  Transaction,
} from "../../../domain/connector/Transaction";
import {
  ChargingProfilePurposeType,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import { LogType } from "../../../shared/Logger";

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
          const resolved = connectorId || 1;
          const connector = cp.getConnector(resolved);
          if (!connector || connector.availability !== "Operative") {
            return { response: { status: "Rejected" } };
          }
          // 1.6 §5.11: the transaction starts while the answer is built.
          remoteStart(cp, resolved, idTag, undefined);
          return { response: { status: "Accepted" } };
        },
      },
      RemoteStopTransaction: {
        mode: "replace",
        handle: (request) => {
          const { transactionId } = request as { transactionId: number };
          // #491, #527: a transaction whose StartTransaction.req was answered
          // with a CALLERROR runs on the `0` placeholder the CSMS never
          // issued; a request naming it is not about this transaction. A `0`
          // the CSMS assigned is (#328).
          const connector = Array.from(cp.connectors.values()).find(
            (c) =>
              c.transaction &&
              c.transaction.id === transactionId &&
              !c.transaction.startCallError,
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
            idToken: { idToken: string };
          };
          const connectorId = req.evseId ?? 1;
          const connector = cp.getConnector(connectorId);
          if (!connector || connector.availability !== "Operative") {
            return { response: { status: "Rejected" } };
          }
          return {
            response: { status: "Accepted" },
            after: async () => {
              remoteStart(
                cp,
                connectorId,
                req.idToken.idToken,
                req.remoteStartId,
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
 * The start of a remote start on either version (1.6 §5.11, 2.x F01):
 * `AuthorizeRemoteTxRequests` asks for an Authorize.req first, then the
 * scenario waiting on the connector gets the request or the default starts
 * the transaction with `triggerReason: "RemoteStart"` (so the local
 * authorize gate does not authorize twice).
 */
function remoteStart(
  cp: ChargePoint,
  connectorId: number,
  idTag: string,
  remoteStartId: number | undefined,
): void {
  if (cp.configuration.authorizeRemoteTxRequests()) {
    if (!isOcpp2Version(cp.ocppVersion)) {
      cp.logger.info(
        `AuthorizeRemoteTxRequests=true: sending Authorize.req for ${idTag}`,
        LogType.OCPP,
      );
    }
    cp.authorize(idTag);
  }
  if (cp.isScenarioHandled(connectorId)) {
    cp.notifyRemoteStartReceived(connectorId, idTag, remoteStartId);
    return;
  }
  // Note it so a scenario that arms on this connector shortly after can tell
  // it raced this exact call (ScenarioRuntime.waitForRemoteStart).
  cp.noteDefaultHandledRemoteStart(connectorId);
  void cp.startTransaction(idTag, connectorId, undefined, undefined, {
    triggerReason: "RemoteStart",
    ...(remoteStartId !== undefined ? { remoteStartId } : {}),
  });
}

const nowDate = (cp: ChargePoint): Date => new Date(cp.clock.now());

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
  if (isLocalStart && cp.configuration.authorizeBeforeLocalStart()) {
    const status = await cp.authorizeAndWait(tagId);
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

  // §5.13: if the connector was Reserved (or the reservation is for
  // connectorId=0 with this idTag), consume that reservation and carry its id
  // into StartTransaction.req so CSMS can close it out.
  const reservation =
    cp.reservationManager.getReservationForConnector(connectorId);
  const reservationId = reservation?.reservationId;

  const transaction: Transaction = {
    id: 0,
    connectorId,
    tagId,
    meterStart: connector.meterValue,
    meterStop: null,
    startTime: nowDate(cp),
    stopTime: null,
    meterSent: false,
    reservationId,
    remoteStartId: options.remoteStartId,
    startTriggerReason: options.triggerReason,
    startChargingState: options.chargingState,
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

  cp.events.emit("transactionStarted", {
    connectorId,
    transactionId: 0,
    tagId,
  });

  return { started: true };
}

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
