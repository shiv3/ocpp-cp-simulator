// Stopping a transaction (the default transaction behavior), split out of
// transaction.ts (#877).
import type {
  ChargePoint,
  StopTransactionOptions,
} from "../../../domain/charge-point/ChargePoint";
import type { Connector } from "../../../domain/connector/Connector";
import type { StopTransactionReason } from "../../../domain/connector/Transaction";
import {
  ChargingProfilePurposeType,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import type { TransactionPorts } from "../../../domain/engine/ChargePointEngine";
import { LogType } from "../../../shared/Logger";

export const nowDate = (cp: ChargePoint): Date => new Date(cp.clock.now());

/** The stop causes that are an authorization ending (#697): with
 *  `TxStopPoint` lacking `Authorized` they give an Updated event, not Ended. */
const AUTHORIZATION_STOP_TRIGGERS: ReadonlySet<string> = new Set([
  "StopAuthorized",
  "RemoteStop",
  "Deauthorized",
]);

/** The stop reasons that are an authorization ending; any other reason
 *  (EVDisconnected, EnergyLimitReached, PowerLoss, ...) ends the transaction. */
const AUTHORIZATION_STOP_REASONS: ReadonlySet<string> = new Set([
  "Local",
  "Remote",
  "DeAuthorized",
]);

/**
 * #697: whether a stop is the end of the authorization only. Applies on 2.x
 * when `TxStopPoint` does not contain `Authorized` and the stop is caused by
 * the idToken (a tag, a RequestStopTransaction, a deauthorization).
 */
function endsAuthorizationOnly(
  cp: ChargePoint,
  options: StopTransactionOptions,
  reason: StopTransactionReason | undefined,
): boolean {
  return (
    isOcpp2Version(cp.ocppVersion) &&
    !cp.configuration.txStopPoint().includes("Authorized") &&
    AUTHORIZATION_STOP_TRIGGERS.has(
      options.triggerReason ?? "StopAuthorized",
    ) &&
    (reason === undefined || AUTHORIZATION_STOP_REASONS.has(reason))
  );
}

/** #697: report an authorization that ended while the stop point is the
 *  cable: an Updated event, the energy stopped, the transaction still open. */
function updateInsteadOfEnding(
  cp: ChargePoint,
  connector: Connector,
  options: StopTransactionOptions,
): void {
  const transaction = connector.transaction;
  if (!transaction) return;
  if (transaction.authorizationEnded) {
    cp.logger.info(
      `Connector ${connector.id} authorization already ended; the transaction ends at the cable unplug (TxStopPoint)`,
      LogType.TRANSACTION,
    );
    return;
  }
  connector.patchTransaction({ authorizationEnded: true });
  connector.holdEnergyForInvalidId(0);
  cp.sendTransactionUpdate(connector.id, {
    triggerReason: options.triggerReason ?? "StopAuthorized",
    chargingState: "SuspendedEVSE",
  });
  if (
    connector.status === OCPPStatus.Charging ||
    connector.status === OCPPStatus.Preparing ||
    connector.status === OCPPStatus.SuspendedEV
  ) {
    cp.updateConnectorStatus(connector.id, OCPPStatus.SuspendedEVSE);
  }
}

/** #727: connectors whose StartTransaction.req (1.x) is not queued yet, with
 *  the stops requested meanwhile. */
export const startsInProgress = new WeakMap<Connector, Array<() => void>>();

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

  // #697: TxStopPoint without Authorized: the authorization ending is an
  // Updated event; the cable ends the transaction.
  if (endsAuthorizationOnly(cp, options, reason)) {
    updateInsteadOfEnding(cp, connector, options);
    return;
  }

  // #607: the Transaction.End sample describes the last charging instant;
  // power reads 0 once the status below leaves Charging.
  const endPoint = connector.operatingPoint();
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
    endPoint,
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
    // The reset models the EV driving away: the cable goes with it, so the
    // next plug-in reports Preparing again (#830 review).
    connector.markEvUnplugged();
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
      scheduled === "Operative"
        ? cp.statusWhenFree(connector.id)
        : OCPPStatus.Unavailable,
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
