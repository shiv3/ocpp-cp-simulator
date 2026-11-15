import { LogType, type Logger } from "../../shared/Logger";
import type { SimClock, TimerHandle } from "../../shared/clock";
import { OCPPStatus } from "../types/OcppTypes";
import { isOcpp2Version } from "../types/OcppVersion";
import type { ChargePoint } from "./ChargePoint";
import type { ConfigurationStore } from "./ConfigurationStore";

/** What the connection timeouts need from their charge point. */
export interface ConnectionTimeoutsHost {
  /** Public members go through it so spies on the charge point still see
   *  them. */
  readonly chargePoint: Pick<
    ChargePoint,
    "getConnector" | "poweredOff" | "stopTransaction" | "updateConnectorStatus"
  >;
  readonly clock: () => SimClock;
  readonly configuration: () => ConfigurationStore;
  readonly logger: () => Logger;
  readonly ocppVersion: () => string;
}

/**
 * The ConnectionTimeOut / EVConnectionTimeOut watchdog of each connector
 * (#527). Owns the timers; the charge point clears them all on close.
 */
export class ConnectionTimeouts {
  // §4.9 B6: per-connector ConnectionTimeOut watchdog. Started when a
  // connector enters Preparing, cleared on any other transition. If the
  // timer fires we auto-transition the connector to Finishing.
  private readonly _timers: Map<number, TimerHandle> = new Map();

  constructor(private readonly host: ConnectionTimeoutsHost) {}

  /** Cancel every watchdog (connection closed). */
  clearAll(): void {
    this._timers.forEach((t) => this.host.clock().clearTimeout(t));
    this._timers.clear();
  }

  /** OCPP 1.x (#527): a connector whose transaction runs is past
   *  ConnectionTimeOut. It waits in Preparing for StartTransaction.conf,
   *  which a CALLERROR resend can hold back for longer than the timeout.
   *  On 2.x the setting is TxCtrlr/EVConnectionTimeOut, which targets
   *  exactly a transaction started before the cable is plugged in, so a
   *  running transaction does not hold it back there. */
  private holdsConnectionTimeout(connectorId: number): boolean {
    return (
      !isOcpp2Version(this.host.ocppVersion()) &&
      !!this.host.chargePoint.getConnector(connectorId)?.hasRunningTransaction
    );
  }

  start(connectorId: number): void {
    this.clear(connectorId);
    const timeoutSec = this.host.configuration()?.connectionTimeOut();
    if (timeoutSec <= 0 || this.holdsConnectionTimeout(connectorId)) return;
    const handle = this.host.clock().setTimeout(() => {
      this._timers.delete(connectorId);
      if (this.host.chargePoint.poweredOff) return; // no power: nothing ends or changes (#798)
      const connector = this.host.chargePoint.getConnector(connectorId);
      if (!connector || connector.status !== OCPPStatus.Preparing) return;
      // E03.FR.05: on 2.x a transaction already started without the EV
      // connecting in time is ended (stoppedReason Timeout, triggerReason
      // EVConnectTimeout). 1.6 keeps the B6 Preparing → Finishing move.
      if (
        isOcpp2Version(this.host.ocppVersion()) &&
        connector.hasRunningTransaction
      ) {
        this.host
          .logger()
          .info(
            `Connector ${connectorId} EVConnectionTimeOut elapsed; ending the transaction (E03.FR.05)`,
            LogType.TRANSACTION,
          );
        this.host.chargePoint.stopTransaction(connector, undefined, {
          triggerReason: "EVConnectTimeout",
          stoppedReason: "Timeout",
        });
        if (connector.status === OCPPStatus.Preparing) {
          this.host.chargePoint.updateConnectorStatus(
            connectorId,
            OCPPStatus.Finishing,
          );
        }
        return;
      }
      if (this.holdsConnectionTimeout(connectorId)) return;
      this.host
        .logger()
        .info(
          `Connector ${connectorId} ConnectionTimeOut elapsed; transitioning Preparing → Finishing (§4.9 B6)`,
          LogType.OCPP,
        );
      this.host.chargePoint.updateConnectorStatus(
        connectorId,
        OCPPStatus.Finishing,
      );
    }, timeoutSec * 1000);
    this._timers.set(connectorId, handle);
  }

  clear(connectorId: number): void {
    const handle = this._timers.get(connectorId);
    if (handle) {
      this.host.clock().clearTimeout(handle);
      this._timers.delete(connectorId);
    }
  }
}
