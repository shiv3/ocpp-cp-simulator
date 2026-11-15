import { LogType, type Logger } from "../../shared/Logger";
import type { EventEmitter } from "../../shared/EventEmitter";
import type { Connector } from "../connector/Connector";
import type { ConnectorWrite } from "../connector/ConnectorRecord";
import type { ChargePointEngine } from "../engine/ChargePointEngine";
import type {
  Reservation,
  ReservationManager,
} from "../reservation/Reservation";
import { syncUnspecifiedReservations } from "../reservation/reservationModel";
import type { ChargePointStateManager } from "../services/ChargePointStateManager";
import type { Outbox } from "../transport/Outbox";
import {
  isChargePointStatus,
  OCPPStatus,
  type ChargePointErrorCode,
  type ChargePointStatus,
  type StatusNotificationOptions,
} from "../types/OcppTypes";
import { isOcpp2Version } from "../types/OcppVersion";
import type { ChargePoint } from "./ChargePoint";
import type { ChargePointEvents } from "./ChargePointEvents";
import type { ConnectionTimeouts } from "./ConnectionTimeouts";

/** What the connector status control needs from its charge point. */
export interface ConnectorStatusHost {
  /** The charge point itself: its public members are called through it so
   *  spies on it still see them, and `syncUnspecifiedReservations` takes it. */
  readonly chargePoint: ChargePoint;
  readonly connectionTimeouts: () => ConnectionTimeouts;
  readonly connectors: () => Map<number, Connector>;
  readonly engine: () => ChargePointEngine;
  readonly events: () => EventEmitter<ChargePointEvents>;
  readonly logger: () => Logger;
  readonly nowDate: () => Date;
  readonly ocppVersion: () => string;
  readonly outbox: () => Outbox;
  readonly reservationManager: () => ReservationManager;
  /** The charge point's own status field (connector 0). */
  readonly status: () => ChargePointStatus;
  readonly setStatus: (status: ChargePointStatus) => void;
  readonly stateManager: () => ChargePointStateManager;
  /** A write to a connector's engine record. */
  readonly writeConnector: (connectorId: number, write: ConnectorWrite) => void;
}

/**
 * Connector and station status: the writes that report a status, the
 * StatusNotifications the CSMS asks for, and the reservations a status ends or
 * a lapse releases (1.6 §5.13, 2.x H01/H04). The charge point keeps the public
 * methods as thin delegates.
 */
export class ConnectorStatusControl {
  constructor(private readonly host: ConnectorStatusHost) {}

  /**
   * A reservation lapsed (its expiry timer, or the ReservationManager sweep)
   * without an explicit CancelReservation. OCPP 2.x first reports it
   * (H04.FR.01, ReservationStatusUpdate `Expired`), then mirrors the cancel
   * path (H04.FR.03, OCPP 1.6 §5.13): drive the connector back to Available
   * through updateConnectorStatus so the CSMS sees the transition on the wire,
   * but only when it's still Reserved: a connector that moved to
   * Charging/Preparing/etc. in the meantime must not be clobbered.
   */
  onReservationExpired(connectorId: number, reservation: Reservation): void {
    if (isOcpp2Version(this.host.ocppVersion())) {
      this.host
        .outbox()
        .sendReservationStatusUpdate(reservation.reservationId, "Expired");
    }
    const connector = this.host.chargePoint.getConnector(connectorId);
    if (connector && connector.status === OCPPStatus.Reserved) {
      this.host.chargePoint.updateConnectorStatus(
        connectorId,
        this.host.chargePoint.statusWhenFree(connectorId),
      );
    }
    syncUnspecifiedReservations(this.host.chargePoint);
  }

  /**
   * OCPP 1.6 §5.13 ("a reservation SHALL be terminated ... when the Charge
   * Point or connector are set to Faulted or Unavailable") and 2.0.1
   * H01.FR.16/17: a connector (or, for connector 0, the whole station) that
   * became Faulted or Unavailable ends the reservations it held. OCPP 2.x
   * reports each as ReservationStatusUpdate `Removed`. The connector keeps
   * the status it just took.
   */
  private terminateReservationsOf(connectorId: number): void {
    const terminated = this.host
      .reservationManager()
      .terminateReservations(connectorId === 0 ? "all" : { connectorId });
    if (!isOcpp2Version(this.host.ocppVersion())) return;
    for (const reservation of terminated) {
      this.host
        .outbox()
        .sendReservationStatusUpdate(reservation.reservationId, "Removed");
    }
  }

  /**
   * Send a StatusNotification.req with explicit errorCode/info/vendorErrorCode
   * — used by scenarios to drive Faulted-with-context paths without mutating
   * the connector's runtime status field (cf. `updateConnectorStatus`).
   *
   * For connectorId === 0, `status` must be Available / Unavailable /
   * Faulted (§7.7); other values are dropped with a warning.
   */
  sendStatusNotificationRaw(
    connectorId: number,
    status: OCPPStatus,
    opts: StatusNotificationOptions,
  ): void {
    if (connectorId === 0 && !isChargePointStatus(status)) {
      this.host
        .logger()
        .warn(
          `Refusing CP-level StatusNotification with status='${status}': only Available/Unavailable/Faulted are valid (§7.7)`,
          LogType.OCPP,
        );
      return;
    }
    this.host.outbox().sendStatusNotification(connectorId, status, {
      errorCode:
        (opts.errorCode as ChargePointErrorCode | undefined) ?? undefined,
      info: opts.info,
      vendorErrorCode: opts.vendorErrorCode,
      vendorId: opts.vendorId,
      timestamp: opts.timestamp,
      suppressChargingStateTransactionEvent:
        opts.suppressChargingStateTransactionEvent ?? true,
    });
  }

  setStationStatus(newStatus: ChargePointStatus): void {
    const previousStatus = this.host.status();
    this.host.setStatus(newStatus);
    if (newStatus === OCPPStatus.Unavailable) {
      // §4.9 note says CP-level (connectorId=0) and individual connector
      // statuses are formally independent. Cascading Unavailable here is a
      // UI-integrity choice: when the CP goes Unavailable (disconnect,
      // ChangeAvailability(0,Inoperative), etc.) the per-connector cards
      // should stop showing stale Operative state.
      this.host.connectors().forEach((connector) => {
        const previousStatus = connector.status;
        if (previousStatus === OCPPStatus.Unavailable) return;
        // Don't clobber a connector mid-transaction. The most common
        // caller is `teardownAfterClose` (WebSocket close), and writing
        // Unavailable here would race with the connector_runtime
        // persistence hook — the last snapshot before shutdown would
        // record Unavailable, and on the next daemon restart the
        // restore would resurrect the transaction inside an Unavailable
        // shell, divergent from the CSMS view that still thinks
        // Charging. Leave the per-connector status alone; the eventual
        // StopTransaction (CSMS-issued or scenario-driven) will move
        // it through Finishing → Available normally.
        if (connector.transaction !== null) return;
        this.host.writeConnector(connector.id, {
          kind: "status",
          status: OCPPStatus.Unavailable,
          scope: "event",
        });
      });
    }
    this.host
      .events()
      .emit("statusChange", { status: newStatus, previousStatus });
    this.host.stateManager().transitionChargePointStatus(newStatus, {
      source: "boundary-setter",
      timestamp: this.host.nowDate(),
    });
  }

  /**
   * Reset one EVSE (2.x B11.FR.08, B12.FR.12/14): it is reported Unavailable
   * and returns to the state it had, which stays Unavailable for an
   * Inoperative EVSE (B11.FR.02) and Reserved for a reserved one (B11.FR.05).
   * No BootNotification: that belongs to a reset of the whole station
   * (B11.FR.03/04). The caller has already ended the EVSE's transaction.
   */
  resetEvse(evseId: number): void {
    const connector = this.host.chargePoint.getConnector(evseId);
    if (!connector) return;
    const previous = connector.status;
    if (previous === OCPPStatus.Unavailable) return;
    this.host.chargePoint.updateConnectorStatus(evseId, OCPPStatus.Unavailable);
    this.host.chargePoint.updateConnectorStatus(evseId, previous);
  }

  updateAllConnectorsStatus(status: OCPPStatus): void {
    this.host
      .connectors()
      .forEach((connector) =>
        this.host.chargePoint.updateConnectorStatus(connector.id, status),
      );
  }

  /**
   * Change a connector's status and report it with a StatusNotification.
   * `allowInvalidTransition`: send it even when the capability profile
   * enforces the OCPP 1.6 §4.9 transition table and the change is not in it
   * (#618) — an explicit request to send an out-of-table transition.
   */
  updateConnectorStatus(
    connectorId: number,
    status: OCPPStatus,
    options: { readonly allowInvalidTransition?: boolean } = {},
  ): void {
    // Connector 0 represents the charge point main controller (OCPP 1.6J
    // §7.7). It only accepts Available / Unavailable / Faulted; trying to
    // drive it into Charging / Reserved / etc. would create an out-of-spec
    // StatusNotification. Drop with a warning rather than silently coercing.
    if (connectorId === 0) {
      if (!isChargePointStatus(status)) {
        this.host
          .logger()
          .warn(
            `Refusing to set connector 0 (CP main controller) to '${status}': only Available/Unavailable/Faulted are valid per OCPP 1.6 §7.7`,
            LogType.SYSTEM,
          );
        return;
      }
      const previousStatus = this.host.status();
      this.host.setStatus(status);
      this.host.events().emit("statusChange", { status, previousStatus });
      this.host.stateManager().transitionChargePointStatus(status, {
        source: "connector-0-update",
        timestamp: this.host.nowDate(),
      });
      this.host
        .logger()
        .info(
          `Charge point status updated: ${previousStatus} -> ${status} (connector 0)`,
          LogType.SYSTEM,
        );
      // CP-level Faulted: send via the same path, no specific connector
      // errorCode available, so we'd pass NoError by default. Callers that
      // want to set a CP-level fault should use sendCpFaultedNotification.
      this.host.outbox().sendStatusNotification(0, status);
      // The station is out of service: no reservation survives (after the
      // status, which the CSMS sees first: H01.FR.16/17).
      if (status !== OCPPStatus.Available) this.terminateReservationsOf(0);
      return;
    }

    const connector = this.host.chargePoint.getConnector(connectorId);
    if (!connector) {
      this.host
        .logger()
        .error(`Connector ${connectorId} not found`, LogType.SYSTEM);
      return;
    }

    // Energy held after a non-Accepted id (E05.FR.02): whichever path asks
    // for Charging, the register is stopped, so report SuspendedEVSE.
    if (
      status === OCPPStatus.Charging &&
      connector.energyHeld &&
      connector.hasRunningTransaction
    ) {
      if (connector.status === OCPPStatus.SuspendedEVSE) return;
      status = OCPPStatus.SuspendedEVSE;
    }

    this.host.engine().dispatch({
      type: "connector.write",
      connectorId,
      write: {
        kind: "status",
        status,
        scope: "full",
        ...(options.allowInvalidTransition
          ? { allowInvalidTransition: true }
          : {}),
      },
    });
  }

  /**
   * The rest of a `full` status write, run by the engine right after the
   * record changed and the listeners were told: the connection-timeout timer
   * and the StatusNotification. `sendNotification` false (an out-of-table
   * transition under `statusTransitions: "enforce"`, #618): everything but
   * the StatusNotification.
   * @internal
   */
  afterConnectorStatus(
    connectorId: number,
    status: OCPPStatus,
    sendNotification = true,
  ): void {
    const connector = this.host.chargePoint.getConnector(connectorId);
    if (!connector) return;

    // §4.9 B6 ConnectionTimeOut: when the connector enters Preparing,
    // start a timer; if it doesn't progress before the timeout, auto-
    // transition to Finishing (= user didn't present an idTag in time).
    if (status === OCPPStatus.Preparing) {
      this.host.connectionTimeouts().start(connectorId);
    } else {
      this.host.connectionTimeouts().clear(connectorId);
    }

    // Faulted state propagates the connector's currentErrorCode; warning-grade
    // notifications during Preparing/Suspended* also do, so the CSMS can
    // see e.g. EVCommunicationError context. NoError is sent for the
    // happy-path transitions.
    const useErrorCode =
      connector.currentErrorCode !== "NoError" || status === OCPPStatus.Faulted;
    if (sendNotification) {
      this.host.outbox().sendStatusNotification(connectorId, status, {
        errorCode: useErrorCode ? connector.currentErrorCode : "NoError",
        info: connector.errorInfo ?? undefined,
        vendorErrorCode: connector.vendorErrorCode ?? undefined,
      });
    }

    // A connector that is Faulted or Unavailable holds no reservation: it is
    // ended after the status the CSMS just saw (H01.FR.16/17).
    if (status === OCPPStatus.Faulted || status === OCPPStatus.Unavailable) {
      this.terminateReservationsOf(connectorId);
    }
    syncUnspecifiedReservations(this.host.chargePoint);
  }

  /**
   * Sends a StatusNotification.req for the current state of the given
   * connector (no domain mutation, no events). Used to satisfy
   * TriggerMessage(StatusNotification) from the CSMS.
   *
   * connectorId 0 means the charge-point main controller.
   * connectorId omitted means "fan out to connector 0 + every connector".
   */
  sendCurrentStatusNotification(connectorId?: number): void {
    if (connectorId === undefined) {
      this.host.outbox().sendStatusNotification(0, this.host.status());
      this.host.connectors().forEach((connector) => {
        this.host
          .outbox()
          .sendStatusNotification(connector.id, connector.status);
      });
      return;
    }
    if (connectorId === 0) {
      this.host.outbox().sendStatusNotification(0, this.host.status());
      return;
    }
    const connector = this.host.chargePoint.getConnector(connectorId);
    if (!connector) {
      this.host
        .logger()
        .error(
          `Connector ${connectorId} not found (TriggerMessage)`,
          LogType.SYSTEM,
        );
      return;
    }
    this.host.outbox().sendStatusNotification(connectorId, connector.status);
  }
}
