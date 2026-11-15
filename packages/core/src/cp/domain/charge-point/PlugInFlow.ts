import { LogType, type Logger } from "../../shared/Logger";
import type { Outbox } from "../transport/Outbox";
import { OCPPStatus } from "../types/OcppTypes";
import { isOcpp2Version } from "../types/OcppVersion";
import type { ChargePoint } from "./ChargePoint";
import type { StartTransactionOptions } from "./ChargePointTypes";
import type { ConfigurationStore } from "./ConfigurationStore";
import type { ConnectionTimeouts } from "./ConnectionTimeouts";

/** What the plug-in flow needs from its charge point. */
export interface PlugInFlowHost {
  /** Public members go through it so spies on the charge point still see
   *  them. */
  readonly chargePoint: Pick<
    ChargePoint,
    | "getConnector"
    | "poweredOff"
    | "startTransaction"
    | "stopTransaction"
    | "updateConnectorStatus"
  >;
  readonly configuration: () => ConfigurationStore;
  readonly connectionTimeouts: () => ConnectionTimeouts;
  readonly logger: () => Logger;
  readonly ocppVersion: () => string;
  readonly outbox: () => Outbox;
}

/**
 * The EV side of the cable (#453): plug-in, unplug, readiness, and the
 * idToken held until the cable arrives (#697). Owns that held token; the
 * charge point keeps the public methods as thin delegates.
 */
export class PlugInFlow {
  /** #697: an idToken authorized before the cable was in, per connector;
   *  `TxStartPoint` `EVConnected` starts the transaction at the plug-in.
   *  Per connector is per EVSE on the 1:1 topology; an EVSE with several
   *  connectors will key it by EVSE (#628). */
  private readonly _tokenAwaitingPlugIn = new Map<
    number,
    { tagId: string; options: StartTransactionOptions }
  >();

  constructor(private readonly host: PlugInFlowHost) {}

  evDisconnected(connectorId: number): void {
    const connector = this.host.chargePoint.getConnector(connectorId);
    if (!connector) {
      this.host
        .logger()
        .error(`Connector ${connectorId} not found`, LogType.TRANSACTION);
      return;
    }

    connector.markEvUnplugged();
    this._tokenAwaitingPlugIn.delete(connectorId);
    if (!connector.hasRunningTransaction) {
      // Only the states that exist because a cable is plugged in fall back
      // to Available (#453); an unplug does not lift an Unavailable, Faulted
      // or Reserved connector, nor repeat an Available.
      if (
        connector.status === OCPPStatus.Preparing ||
        connector.status === OCPPStatus.Finishing ||
        connector.status === OCPPStatus.SuspendedEV ||
        connector.status === OCPPStatus.SuspendedEVSE
      ) {
        this.host.chargePoint.updateConnectorStatus(
          connectorId,
          OCPPStatus.Available,
        );
      }
      return;
    }

    if (
      connector.energyOfferSuspended &&
      connector.status === OCPPStatus.SuspendedEV
    ) {
      this.host
        .logger()
        .debug(
          `Connector ${connectorId} EV side already disconnected, ignoring`,
          LogType.TRANSACTION,
        );
      return;
    }

    if (this.host.configuration().stopTransactionOnEVSideDisconnect()) {
      this.host
        .logger()
        .info(
          `Connector ${connectorId} EV side disconnected, stopping the transaction (StopTransactionOnEVSideDisconnect=true)`,
          LogType.TRANSACTION,
        );
      this.host.chargePoint.stopTransaction(connector, "EVDisconnected", {
        triggerReason: "EVCommunicationLost",
        stoppedReason: "EVDisconnected",
      });
      return;
    }

    this.host
      .logger()
      .info(
        `Connector ${connectorId} EV side disconnected, suspending the transaction (StopTransactionOnEVSideDisconnect=false)`,
        LogType.TRANSACTION,
      );
    connector.suspendEnergyOffer();
    if (isOcpp2Version(this.host.ocppVersion())) {
      this.host.outbox().sendTransactionUpdate(connectorId, {
        triggerReason: "EVCommunicationLost",
        chargingState: "SuspendedEV",
      });
    }
    this.host.chargePoint.updateConnectorStatus(
      connectorId,
      OCPPStatus.SuspendedEV,
    );
  }

  statusWhenFree(connectorId: number): OCPPStatus {
    const connector = this.host.chargePoint.getConnector(connectorId);
    return connector &&
      connectorId !== 0 &&
      !this.host.chargePoint.poweredOff &&
      !connector.hasRunningTransaction &&
      connector.evConnection !== "disconnected"
      ? OCPPStatus.Preparing
      : OCPPStatus.Available;
  }

  evPlugIn(connectorId: number): void {
    const connector = this.host.chargePoint.getConnector(connectorId);
    if (!connector || connectorId === 0) {
      this.host
        .logger()
        .error(`Connector ${connectorId} not found`, LogType.TRANSACTION);
      return;
    }
    if (connector.evConnection !== "disconnected") {
      // A cable recorded while the connector shows Available (a path that
      // freed it without looking at the cable) still reports the plug-in.
      if (
        !this.host.chargePoint.poweredOff &&
        !connector.hasRunningTransaction &&
        connector.status === OCPPStatus.Available
      ) {
        this.host.chargePoint.updateConnectorStatus(
          connectorId,
          OCPPStatus.Preparing,
        );
      }
      return;
    }
    connector.markEvPluggedIn();
    if (
      isOcpp2Version(this.host.ocppVersion()) &&
      connector.hasRunningTransaction &&
      !this.host.chargePoint.poweredOff
    ) {
      // E03 (idToken first): the cable arrives after the transaction began.
      // E03.FR.12 / E02.FR.17: Updated, CablePluggedIn, chargingState
      // EVConnected; the EVConnectionTimeOut is over (E03.FR.05 applies only
      // when no EV connects); the energy offer then starts (Charging).
      this.host.connectionTimeouts().clear(connectorId);
      this.host.outbox().sendTransactionUpdate(connectorId, {
        triggerReason: "CablePluggedIn",
        chargingState: "EVConnected",
      });
      if (connector.status === OCPPStatus.Preparing) {
        this.host.chargePoint.updateConnectorStatus(
          connectorId,
          OCPPStatus.Charging,
        );
      }
      return;
    }
    if (
      !this.host.chargePoint.poweredOff &&
      !connector.hasRunningTransaction &&
      connector.status === OCPPStatus.Available
    ) {
      // #697: TxStartPoint EVConnected starts the transaction at the
      // plug-in (Started, CablePluggedIn, EVConnected); the idToken that
      // follows is an Updated event. The start puts the connector in
      // Preparing itself.
      if (
        isOcpp2Version(this.host.ocppVersion()) &&
        connector.availability === "Operative" &&
        this.host.configuration().txStartPoint().includes("EVConnected")
      ) {
        const waiting = this._tokenAwaitingPlugIn.get(connectorId);
        this._tokenAwaitingPlugIn.delete(connectorId);
        void (async () => {
          await this.host.chargePoint.startTransaction(
            "",
            connectorId,
            undefined,
            undefined,
            {
              awaitAuthorization: true,
              triggerReason: "CablePluggedIn",
              chargingState: "EVConnected",
            },
          );
          // The token authorized before the plug-in joins the transaction
          // the cable just started (Updated Authorized / RemoteStart).
          if (waiting) {
            await this.host.chargePoint.startTransaction(
              waiting.tagId,
              connectorId,
              undefined,
              undefined,
              { ...waiting.options, preAuthorized: true },
            );
          }
        })();
        return;
      }
      this.host.chargePoint.updateConnectorStatus(
        connectorId,
        OCPPStatus.Preparing,
      );
    }
  }

  deferStartUntilPlugIn(
    connectorId: number,
    tagId: string,
    options: StartTransactionOptions,
  ): void {
    this._tokenAwaitingPlugIn.set(connectorId, { tagId, options });
  }

  evSetReady(connectorId: number, ready: boolean): void {
    const connector = this.host.chargePoint.getConnector(connectorId);
    if (!connector || connectorId === 0) {
      this.host
        .logger()
        .error(`Connector ${connectorId} not found`, LogType.TRANSACTION);
      return;
    }
    if (connector.evConnection === "disconnected") {
      throw new Error(`Connector ${connectorId} has no EV plugged in`);
    }
    connector.markEvReady(ready);
    if (!connector.hasRunningTransaction) return;
    if (!ready) {
      if (connector.status !== OCPPStatus.Charging) return;
      connector.suspendEnergyOffer();
      // On 2.x the status write carries the TransactionEvent(Updated).
      this.host.chargePoint.updateConnectorStatus(
        connectorId,
        OCPPStatus.SuspendedEV,
      );
      return;
    }
    if (
      connector.status !== OCPPStatus.SuspendedEV ||
      !connector.energyOfferSuspended
    ) {
      return;
    }
    this.host.chargePoint.updateConnectorStatus(
      connectorId,
      OCPPStatus.Charging,
    );
  }
}
