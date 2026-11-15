import { LogType, type Logger } from "../../shared/Logger";
import type { EventEmitter } from "../../shared/EventEmitter";
import type { SimClock } from "../../shared/clock";
import type { ActiveChargingProfile, Connector } from "../connector/Connector";
import type { ConnectorWrite } from "../connector/ConnectorRecord";
import type { ChargePointEngine } from "../engine/ChargePointEngine";
import type { MonitorEvaluation } from "../monitoring/MonitorEvaluation";
import type { LogSink } from "../persistence/LogSink";
import type { LocalAuthListManager } from "../auth/LocalAuthList";
import type {
  Reservation,
  ReservationManager,
} from "../reservation/Reservation";
import type { ChargePointHeartbeat } from "../services/ChargePointHeartbeat";
import type { ChargePointTimelineProjector } from "../services/ChargePointTimeline";
import type {
  ChargePointSocket,
  SocketClose,
} from "../transport/ChargePointSocket";
import type { CloseCause } from "../transport/networkSim";
import type { Outbox } from "../transport/Outbox";
import { OCPPStatus, type BootReason } from "../types/OcppTypes";
import { isOcpp2Version } from "../types/OcppVersion";
import type { BootState, BootLifecycle } from "./BootLifecycle";
import type { CallOverrides } from "./CallOverrides";
import type { CellularLinkController } from "./CellularLinkController";
import type { ChargePoint } from "./ChargePoint";
import type { ChargePointEvents } from "./ChargePointEvents";
import type { ChargingProfileStore } from "./ChargingProfileStore";
import type { ClientCertificateSwitch } from "./ClientCertificateSwitch";
import type { ClockAlignedMeterScheduler } from "./ClockAlignedMeterScheduler";
import type { ConfigurationStore } from "./ConfigurationStore";
import type { ConnectionTimeouts } from "./ConnectionTimeouts";
import type { MeterSampling } from "./MeterSampling";
import type { PowerLossController } from "./PowerLossController";
import type { ScenarioCallOwnership } from "./ScenarioCallOwnership";
import { toV2ConnectorStatus } from "./runtimeValueKeys";
import type { VehicleBehaviorDriver } from "./VehicleBehaviorDriver";

/** RFC 6455 Normal Closure, and No Status Received (a close without a code). */
const NORMAL_CLOSE_CODES: ReadonlySet<number> = new Set([1000, 1005]);

/** What the outage lifecycle needs from its charge point. */
export interface OutageHost {
  /** Public members go through it so spies on the charge point still see
   *  them. */
  readonly chargePoint: Pick<
    ChargePoint,
    | "applyChargingProfile"
    | "boot"
    | "bootPayload"
    | "clearChargingProfiles"
    | "connect"
    | "connectors"
    | "disconnect"
    | "error"
    | "startHeartbeat"
    | "status"
    | "stopMonitoring"
    | "updateConnectorStatus"
  >;
  /** The boot facts the charge point shares with the boot lifecycle. */
  readonly state: BootState;
  readonly boot: () => BootLifecycle;
  readonly callOverrides: () => CallOverrides;
  readonly cellular: () => CellularLinkController;
  readonly certSwitch: () => ClientCertificateSwitch;
  readonly clock: () => SimClock;
  readonly clockAligned: () => ClockAlignedMeterScheduler;
  readonly configuration: () => ConfigurationStore;
  readonly connectionTimeouts: () => ConnectionTimeouts;
  readonly connectors: () => Map<number, Connector>;
  readonly engine: () => ChargePointEngine;
  readonly events: () => EventEmitter<ChargePointEvents>;
  readonly heartbeat: () => ChargePointHeartbeat;
  readonly localAuthListManager: () => LocalAuthListManager;
  readonly logSink: () => LogSink;
  readonly logger: () => Logger;
  readonly monitorEvaluation: () => MonitorEvaluation | undefined;
  readonly nowDate: () => Date;
  readonly ocppVersion: () => string;
  readonly outbox: () => Outbox;
  readonly power: () => PowerLossController;
  readonly reservationManager: () => ReservationManager;
  readonly sampling: () => MeterSampling;
  readonly scenarioCalls: () => ScenarioCallOwnership;
  readonly stationProfiles: () => ChargingProfileStore;
  readonly timelineProjector: () => ChargePointTimelineProjector;
  readonly txEndedAligned: () => ClockAlignedMeterScheduler;
  readonly vehicleDrivers: () => Map<number, VehicleBehaviorDriver>;
  readonly webSocket: () => ChargePointSocket | null;
  /** Log the capability profile's conflicts with `SupportedFeatureProfiles`. */
  readonly warnCapabilityProfileConflicts: () => void;
  /** A write to a connector's engine record. */
  readonly writeConnector: (connectorId: number, write: ConnectorWrite) => void;
}

/**
 * The connection lifecycle: connect, socket open, disconnect, reset, the
 * teardown after a close, the resume after a reconnect and dispose. Owns what
 * the current outage recorded (#702) and the "next open boots" flag; the
 * charge point keeps the public methods as thin delegates.
 */
export class OutageLifecycle {
  /** #702: the next socket open is a (re)start of the link — the first
   *  connect, an operator `connect()`, a Reset — and sends a
   *  BootNotification. Only the transport's automatic reconnect after a
   *  connection loss finds it false. */
  bootOnNextOpen = true;
  /** #702: when the current outage began (first teardown of it). */
  private _offlineSince: number | null = null;
  /** #702: the statuses (0 = the charge point) the station had when the
   *  outage began, before the teardown made them Unavailable. */
  private _statusAtDrop: Map<number, OCPPStatus> = new Map();
  /** #702: the connectors whose Unavailable was made by the teardown
   *  cascade (not by an availability change), with the status they had. */
  private _cascadedAtDrop: Map<number, OCPPStatus> = new Map();
  /** #702: the reservations held when the outage began; a resumed link gets
   *  them back (a reboot does not). */
  private _reservationsAtDrop: Reservation[] = [];
  /** #799: the station-level charging profiles held when the outage began.
   *  The teardown empties the store; a resumed link (no BootNotification, so
   *  the CSMS has no cue to push its limits again) gets them back. */
  private _stationProfilesAtDrop: ActiveChargingProfile[] = [];
  /** #702: the status the CSMS last *answered* for each connector (0 = the
   *  charge point). A StatusNotification still in flight when the link closed
   *  is not in it, so a resume sends that one again (B04.FR.02). */
  ackedStatus: Map<number, OCPPStatus> = new Map();

  constructor(private readonly host: OutageHost) {}

  connect(): void {
    const host = this.host;
    if (host.power().poweredOff) {
      host
        .logger()
        .warn(
          "connect() ignored: the charge point has no power (power.restore first)",
          LogType.WEBSOCKET,
        );
      return;
    }
    const webSocket = host.webSocket();
    if (!webSocket) {
      host
        .logger()
        .info(`Connecting via ${host.ocppVersion()} SOAP client`, LogType.OCPP);
      host.boot().bootRetries = 0;
      host.chargePoint.boot();
      host.events().emit("connected", undefined);
      host.engine().observe({ type: "connected" });
      return;
    }

    host.warnCapabilityProfileConflicts();

    const link = host.cellular().link;
    if (link?.available === false) {
      // #930: the cellular link is down; an operator connect cannot defeat
      // that. Remembered, so restoring service dials. No boot flag is set:
      // whether a BootNotification follows stays the #702 rule.
      host
        .logger()
        .info(
          `connect() deferred: the cellular link is unavailable (${link.reasons.join(", ")})`,
          LogType.WEBSOCKET,
        );
      host.cellular().deferConnectUntilLinkRestored();
      return;
    }
    // Idempotent: if a socket is already open or mid-handshake, don't
    // create a second one. The daemon's startServer can hit this twice
    // when restoreFromDatabase() auto-connects and then the bootstrap
    // path also calls svc.connect() on the same restored instance — each
    // call would otherwise overwrite `_ws` with a fresh socket and the
    // orphaned one's onClose would mark all connectors Unavailable on the
    // CSMS side.
    //
    // Only synthesize a "connected" event when the socket is already OPEN;
    // for CONNECTING we let the natural handshake fire it so callers that
    // gate on "connected" don't unblock before BootNotification.req
    // actually goes out.
    if (webSocket.isOpenOrConnecting()) {
      host
        .logger()
        .info(
          "connect() ignored: WebSocket is already open or connecting",
          LogType.WEBSOCKET,
        );
      if (webSocket.isConnected()) {
        host.events().emit("connected", undefined);
      }
      return;
    }
    this.bootOnNextOpen = true;
    webSocket.connect(
      () => {
        // A new connection starts a fresh BootNotification budget (#609).
        host.boot().bootRetries = 0;
        const resumed = this.onSocketOpen();
        host.events().emit("connected", undefined);
        if (resumed) host.events().emit("reconnectResumed", resumed);
        host.engine().observe({ type: "connected" });
        // The queued-message flush itself is triggered by
        // markBootAccepted(); we just need the WebSocket to come up and
        // BootNotification to round-trip first.
      },
      (ev: SocketClose, cause: CloseCause) => {
        // Same teardown as an explicit disconnect() — heartbeat, scenario
        // state, connector listeners, etc. — so a CSMS-initiated close
        // doesn't leave background timers firing against a dead socket.
        this.teardownAfterClose();
        // #474: a close the charge point asked for (operator disconnect,
        // reset, network-sim cut, dispose) or a normal closure is not a
        // failure; the transport already logged it at INFO with its cause.
        const failure =
          cause === "network" && !NORMAL_CLOSE_CODES.has(ev.code)
            ? `WebSocket closed code: ${ev.code} reason: ${ev.reason}`
            : null;
        if (failure) host.logger().error(failure, LogType.WEBSOCKET);
        host
          .events()
          .emit("disconnected", { code: ev.code, reason: ev.reason });
        host.engine().observe({
          type: "disconnected",
          code: ev.code,
          reason: ev.reason,
        });
        if (failure) host.chargePoint.error = failure;
      },
    );
  }

  /**
   * The socket is open. A (re)start of the link sends a BootNotification; the
   * transport's automatic reconnect after a connection loss on OCPP 2.x does
   * not while the boot data is unchanged and the last boot was Accepted
   * (OCPP-J 2.0.1 §5.4: "SHOULD NOT send a BootNotification unless one or
   * more of the elements … have changed"; #702). `BootOnReconnect` keeps the
   * boot on every connect.
   */
  private onSocketOpen(): ChargePointEvents["reconnectResumed"] | null {
    const restart = this.bootOnNextOpen;
    this.bootOnNextOpen = false;
    if (
      !restart &&
      isOcpp2Version(this.host.ocppVersion()) &&
      !this.host.configuration().bootOnReconnect() &&
      this.host.state.bootedWith !== null &&
      this.host.state.bootedWith ===
        JSON.stringify(this.host.chargePoint.bootPayload())
    ) {
      return this.resumeAfterReconnect();
    }
    this.clearOutage();
    this.host.chargePoint.boot();
    return null;
  }

  /** The outage is over: forget what it recorded (#702). */
  clearOutage(): void {
    this._offlineSince = null;
    this._statusAtDrop = new Map();
    this._cascadedAtDrop = new Map();
    this._reservationsAtDrop = [];
    this._stationProfilesAtDrop = [];
  }

  /**
   * The effects of an Accepted boot that a reconnect still needs, without the
   * BootNotification (#702): B04.FR.01/02 status reports, the heartbeat, the
   * clock-aligned and monitoring timers and the E11 replay of the queued
   * TransactionEvents (E11.FR.02).
   *
   * The connection loss left the connectors `Unavailable` locally (the CSMS
   * never heard of it). They get their status back without a wire message;
   * a StatusNotification goes out for those whose status differs from what
   * the CSMS knew, and for all of them when the outage was longer than
   * `OfflineThreshold`.
   */
  private resumeAfterReconnect(): ChargePointEvents["reconnectResumed"] {
    const host = this.host;
    const cp = host.chargePoint;
    const offlineMs =
      this._offlineSince === null ? 0 : host.clock().now() - this._offlineSince;
    const atDrop = this._statusAtDrop;
    const cascaded = this._cascadedAtDrop;
    const reservations = this._reservationsAtDrop;
    const stationProfiles = this._stationProfilesAtDrop;
    this.clearOutage();
    const reportAll =
      offlineMs > host.configuration().offlineThreshold() * 1000;
    host
      .logger()
      .info(
        `Reconnected after ${Math.round(offlineMs / 1000)}s offline; no BootNotification (boot data unchanged), reporting ${
          reportAll ? "all connectors" : "the connectors that changed"
        }`,
        LogType.OCPP,
      );
    host.outbox().setBootStatus({ status: "Accepted" });
    host.state.bootAccepted = true;
    cp.error = "";

    // A link loss is not a reboot: the reservations survive it (B01.FR.13
    // keeps Reserved even across a reboot), with their expiry timer.
    const reserved = new Set(
      host
        .reservationManager()
        .restore(reservations)
        .map((reservation) => reservation.connectorId),
    );

    // Likewise the station-level charging profiles (ChargingStationMaxProfile,
    // station TxDefaultProfile): without a boot the CSMS has no cue to push
    // them again, and nothing allows dropping them on a connection loss
    // (#799). A profile that expired during the outage stays gone.
    const resumedAt = host.nowDate();
    for (const profile of stationProfiles) {
      if (profile.validTo && new Date(profile.validTo) <= resumedAt) continue;
      cp.applyChargingProfile(profile, "SetChargingProfile");
    }

    // What the CSMS last answered is what it knows; the station's own state
    // now decides what is true, and the difference is reported (B04.FR.02).
    const acked = this.ackedStatus;
    const cpAtDrop = (atDrop.get(0) ?? OCPPStatus.Available) as
      OCPPStatus.Available | OCPPStatus.Unavailable | OCPPStatus.Faulted;
    const cpNow = cp.status;
    const cpTarget = cpNow === OCPPStatus.Unavailable ? cpAtDrop : cpNow;
    if (cpTarget !== cpNow) cp.status = cpTarget;
    // Compared as the 2.x wire carries them (Preparing and Charging are both
    // `Occupied`): the CSMS knows nothing else.
    const knows = (id: number, target: OCPPStatus): boolean => {
      const known = acked.get(id);
      return (
        known !== undefined &&
        toV2ConnectorStatus(known) === toV2ConnectorStatus(target)
      );
    };
    if (reportAll || !knows(0, cpTarget)) {
      cp.updateConnectorStatus(0, cpTarget);
    }
    cp.connectors.forEach((connector) => {
      let target = connector.status;
      const made = cascaded.get(connector.id);
      if (
        target === OCPPStatus.Unavailable &&
        made !== undefined &&
        connector.transaction === null &&
        // An availability change made while the link was going down is real.
        connector.availability !== "Inoperative"
      ) {
        target =
          made === OCPPStatus.Reserved && !reserved.has(connector.id)
            ? OCPPStatus.Available
            : made;
        host.writeConnector(connector.id, {
          kind: "status",
          status: target,
          scope: "event",
        });
      }
      if (reportAll || !knows(connector.id, target)) {
        cp.updateConnectorStatus(connector.id, target);
      }
    });

    // The interval in force (the CSMS's, or one set since) survives the
    // teardown, which only stopped the timer; re-arm it.
    cp.startHeartbeat(host.heartbeat().intervalSeconds);
    host.clockAligned().enable();
    host.monitorEvaluation()?.setReporting(true);
    // After the status reports, as for an accepted boot.
    queueMicrotask(() => host.outbox().flushPendingQueue());
    return { offlineMs, reportedAll: reportAll };
  }

  disconnect(): void {
    const host = this.host;
    host.cellular().clearConnectOnLinkRestore();
    host
      .logger()
      .info(
        host.webSocket()
          ? "Disconnecting from WebSocket"
          : `Disconnecting ${host.ocppVersion()} SOAP client`,
        host.webSocket() ? LogType.WEBSOCKET : LogType.OCPP,
      );
    // A renewed certificate is presented at the next connect() (#537).
    host.webSocket()?.disconnect(); // drains network-sim pipelines synchronously (spec 2.6 step 1)
    this.teardownAfterClose(); // handler teardown incl. serializer _serialQueue salvage (step 2)
  }

  /**
   * Common teardown for both user-initiated disconnect() and the
   * WebSocket's onclose path. Sets the CP+connector status to Unavailable,
   * stops the heartbeat, cleans up connector listeners, and releases the
   * reservation manager so no timers / event handlers keep running against
   * a dead socket.
   */
  teardownAfterClose(): void {
    const host = this.host;
    const connectors = host.connectors();
    host.state.bootAccepted = false;
    // #702: remember what the CSMS knew when the outage began; a repeated
    // teardown of the same outage must not record the Unavailable it made.
    if (host.state.bootUnanswered) this.bootOnNextOpen = true;
    if (this._offlineSince === null) {
      this._offlineSince = host.clock().now();
      this._statusAtDrop = new Map([
        [0, host.chargePoint.status],
        ...[...connectors.values()].map(
          (connector) => [connector.id, connector.status] as const,
        ),
      ]);
      this._reservationsAtDrop = host.reservationManager().getAllReservations();
      this._stationProfilesAtDrop = [...host.stationProfiles().all()];
    }
    // A `triggerOn: "connect"` scenario is armed once per connect, recorded on
    // `Connector.lastAutoStartedScenarioKey` so re-emitting Available doesn't
    // restart something already running. That arm must not survive the socket
    // dying: both auto-start engines (CLIChargePointService.
    // tryAutoStartForConnector for the daemon, LocalScenarioRuntime for
    // browser local mode) gate on the key, so
    // a stale arm means the scenario never re-fires after a reconnect. In the
    // daemon that silently kills a CLI-bootstrapped RemoteStart responder --
    // the CP reconnects and boots, but nothing answers RemoteStartTransaction
    // until an operator re-fires the template by hand.
    //
    // Cleared BEFORE the `status` assignment below: that setter cascades
    // Unavailable onto every connector, whose statusChange event is what
    // drives persistConnectorRuntime. Clearing afterwards would persist the
    // stale key into `connector_runtime.last_auto_started_scenario_key` and
    // outlive a process restart too.
    connectors.forEach((connector) => {
      connector.lastAutoStartedScenarioKey = null;
    });
    host.chargePoint.status = OCPPStatus.Unavailable;
    if (this._cascadedAtDrop.size === 0) {
      // First teardown of the outage: which Unavailable did the cascade make?
      for (const connector of connectors.values()) {
        const before = this._statusAtDrop.get(connector.id);
        if (
          before !== undefined &&
          before !== OCPPStatus.Unavailable &&
          connector.status === OCPPStatus.Unavailable
        ) {
          this._cascadedAtDrop.set(connector.id, before);
        }
      }
    }
    host.heartbeat().cleanup();
    host.clockAligned().disable();
    host.txEndedAligned().disable();
    // Offline: events at or below OfflineQueuingSeverity are queued
    // (N07.FR.04, N08.FR.03) until the next boot is Accepted (#538).
    host.monitorEvaluation()?.setOffline();
    connectors.forEach((connector) => connector.cleanup());
    host.reservationManager().dispose();
    // The Local Authorization List is kept: it is what authorizes while the
    // connection is down (§3.5.3, LocalAuthorizeOffline), so a connection
    // loss must not empty it (#534). Only dispose() drops it.
    host.chargePoint.clearChargingProfiles(0, {}, "ConnectionClosed");
    // The engine ends the follow-up of answers a behavior of the user gave
    // (they are bound to the connection). The follow-up of a default behavior,
    // such as the firmware status train, goes on: it did before the engine.
    host.engine().connectionClosed();
    host.scenarioCalls().clear();
    // Issue #110: stale response overrides must not survive a
    // disconnect — they would silently answer the next real CSMS call.
    host.callOverrides().clearResponseOverrides();
    // Cancel all ConnectionTimeOut watchdogs so the timer doesn't fire
    // against a disconnected CP.
    host.connectionTimeouts().clearAll();
    // §4.1.1 serializer: drop the in-flight CALL + queued CALLs since the
    // WebSocket they target is gone. Transaction-related ones go to the
    // PendingMessageQueue (1.6 §3.7; 2.x E11 TransactionEvents, #528).
    host.outbox().onWebSocketClosed();
    // Flush any buffered log lines so the operator can still see the
    // last seconds of activity after the CP went down.
    host.logSink().flush();
  }

  reset(reason: BootReason): void {
    const host = this.host;
    host.state.bootReason = reason;
    // The reset's own boot goes out at the next open, even when the link is
    // down and the connect below is deferred (#930).
    this.bootOnNextOpen = true;
    const webSocket = host.webSocket();
    if (webSocket) {
      // WebSocket CP: use cause-aware internal reset (preserves reconnect reservation)
      webSocket.disconnectInternal(); // drains, does NOT set manual, does NOT clear reservation
      this.teardownAfterClose(); // drain-before-teardown order preserved
    } else {
      // SOAP CP: fallback to the old disconnect+connect semantics
      host.chargePoint.disconnect();
    }
    host.chargePoint.connect();
  }

  /**
   * Terminal teardown: permanently releases the charge point.
   * Shuts down the network-sim controller and closes the socket,
   * then runs final CP-side teardown.
   */
  dispose(): void {
    const host = this.host;
    const drivers = host.vehicleDrivers();
    for (const driver of drivers.values()) driver.dispose();
    drivers.clear();
    host.power().clearRestoreTimer();
    host.certSwitch().release();
    for (const connectorId of [...host.sampling().samplers.keys()]) {
      host.sampling().stopPeriodicSampling(connectorId);
    }
    host.webSocket()?.dispose(); // terminal: shuts controller down, clears reservation, closes socket
    this.teardownAfterClose(); // final CP-side teardown
    host.engine().dispose();
    // Offline monitoring keeps the periodic timers running: stop them.
    host.chargePoint.stopMonitoring();
    host.localAuthListManager().dispose();
    host.timelineProjector().dispose();
    // The socket's real close event still arrives asynchronously and its
    // handler logs "WebSocket closed" through this log sink. Closing it
    // here (not in teardownAfterClose, which a plain disconnect shares)
    // drops that late line instead of buffering it — otherwise a `cp.delete`
    // that just cascaded to `logs` gets one row back for the deleted id
    // (#326).
    host.logSink().close();
  }
}
