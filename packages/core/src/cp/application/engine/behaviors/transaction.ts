import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { IdTokenTypeName } from "../../../domain/connector/Transaction";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import { LogType } from "../../../shared/Logger";
import { startRefusalByReservation } from "../../../domain/reservation/reservationModel";
import { decideRemoteStart } from "./remoteStartValidation";

export { startTransaction } from "./transactionStart";
export { cleanTransaction, stopTransaction } from "./transactionStop";

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
            : pickRemoteStartConnector(cp, idTag);
          if (resolved === undefined) {
            return { response: { status: "Rejected" } };
          }
          // 1.6 §5.11: with AuthorizeRemoteTxRequests the request is answered,
          // then authorized like a local action (#921; the order the OCA
          // TC_010 / TC_011_1 / TC_059 cases check). Otherwise the
          // transaction starts while the answer is built.
          if (cp.configuration.authorizeRemoteTxRequests()) {
            return {
              response: { status: "Accepted" },
              after: () => remoteStart(cp, resolved, idTag, undefined),
            };
          }
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
          // F01.FR.xx / #697: a transaction the cable already started is the
          // one this request authorizes; the response names it.
          const awaiting = cp.getConnector(connectorId)?.transaction;
          const startedId =
            awaiting?.awaitingAuthorization && awaiting.stopTime === null
              ? awaiting.cpTransactionId
              : undefined;
          return {
            response: {
              status: "Accepted",
              ...(startedId !== undefined ? { transactionId: startedId } : {}),
            },
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
/**
 * 1.6 RemoteStartTransaction without a `connectorId` (#839): the connector
 * reserved for this tag (or its parent) comes first, as on 2.x
 * (`decideRemoteStart`), so the reservation is used up instead of staying and
 * blocking others; otherwise the lowest connector that can start.
 */
export function pickRemoteStartConnector(
  cp: ChargePoint,
  idTag: string,
): number | undefined {
  const ids = [...cp.connectors.keys()]
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
  const parent = cp.knownParentIdOf(idTag);
  return (
    ids.find(
      (id) =>
        cp.reservationManager.reservationFor(id, idTag, parent) !== undefined &&
        remoteStartable(cp, id, idTag),
    ) ?? ids.find((id) => remoteStartable(cp, id, idTag))
  );
}

function remoteStartable(
  cp: ChargePoint,
  connectorId: number,
  idTag: string,
): boolean {
  const connector = cp.getConnector(connectorId);
  if (!connector || connector.availability !== "Operative") return false;
  if (connector.status === OCPPStatus.Faulted) return false;
  // #697: a transaction the cable started waits for its idToken.
  if (
    connector.hasRunningTransaction &&
    !connector.transaction?.awaitingAuthorization
  ) {
    return false;
  }
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
 * With `AuthorizeRemoteTxRequests` (2.x: `AuthorizeRemoteStart`) true the
 * station behaves as for a local action and starts only after the
 * authorization (local list, cache or Authorize.req) is `Accepted`; an
 * unanswered Authorize does not start (1.6 §5.11: "a transaction will only be
 * started after authorization was obtained", #921; 2.x F01.FR.01). On 2.x an
 * `idToken.type` of `Central` / `NoAuthorization` starts without checking and
 * sends no Authorize (F01.FR.02). The RemoteStartTransaction /
 * RequestStartTransaction answer has gone out before this runs. A scenario
 * waiting on the connector gets the request (with the Authorize sent
 * alongside, the scenario deciding the start); otherwise the default starts
 * the transaction with `triggerReason: "RemoteStart"` (so the local authorize
 * gate does not authorize twice).
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
        `AuthorizeRemoteTxRequests=true: authorizing ${idTag} before the remote start`,
        LogType.OCPP,
      );
    }
    if (!cp.isScenarioHandled(connectorId)) {
      const status = await cp.authorizeAndWait(idTag, undefined, idTokenType, {
        failClosed: true,
      });
      if (status !== "Accepted") {
        cp.logger.warn(
          `Authorize.conf ${status} for ${idTag}; not starting the remote transaction on connector ${connectorId} (${ocpp2 ? "F01.FR.01" : "§5.11"})`,
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
