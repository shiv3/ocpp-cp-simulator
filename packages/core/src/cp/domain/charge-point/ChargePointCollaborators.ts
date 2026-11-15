import type { Logger } from "../../shared/Logger";
import type { EventEmitter } from "../../shared/EventEmitter";
import type { SimClock } from "../../shared/clock";
import type { StationAuthorization } from "../auth/StationAuthorization";
import type { LocalAuthListManager } from "../auth/LocalAuthList";
import type { Connector } from "../connector/Connector";
import type { ConnectorWrite } from "../connector/ConnectorRecord";
import type { ChargePointEngine } from "../engine/ChargePointEngine";
import type { MonitoringStore } from "../monitoring/MonitoringStore";
import type { MonitorEvaluation } from "../monitoring/MonitorEvaluation";
import type { LogSink } from "../persistence/LogSink";
import type { ChargePointRepositories } from "../persistence/ChargePointRepositories";
import type { ReservationManager } from "../reservation/Reservation";
import type { CertificateStore } from "../security/CertificateStore";
import type { NetworkProfileStore } from "../security/networkProfiles";
import type { ChargePointHeartbeat } from "../services/ChargePointHeartbeat";
import type { ChargePointStateManager } from "../services/ChargePointStateManager";
import type { ChargePointTimelineProjector } from "../services/ChargePointTimeline";
import type { StationTopology } from "../topology/StationTopology";
import type { ChargePointSocket } from "../transport/ChargePointSocket";
import type { OcppCallActions } from "../transport/OcppCallActions";
import type { Outbox } from "../transport/Outbox";
import type { RawFrameSink } from "../transport/RawFrameSink";
import type { OCPPAvailability, ChargePointStatus } from "../types/OcppTypes";
import type { ReconnectPolicy } from "../../shared/ReconnectPolicy";
import { AuthorizationFlow } from "./AuthorizationFlow";
import { BootLifecycle, BootStateStore } from "./BootLifecycle";
import { CallOverrides } from "./CallOverrides";
import type { CellularLinkController } from "./CellularLinkController";
import type { ChargePoint } from "./ChargePoint";
import { ChargingProfileControl } from "./ChargingProfileControl";
import type { ChargingProfileStore } from "./ChargingProfileStore";
import { ClientCertificateSwitch } from "./ClientCertificateSwitch";
import type { ClockAlignedMeterScheduler } from "./ClockAlignedMeterScheduler";
import { ConfigurationWiring } from "./ConfigurationWiring";
import type { ConfigurationStore } from "./ConfigurationStore";
import { ConnectionTimeouts } from "./ConnectionTimeouts";
import { ConnectorStatusControl } from "./ConnectorStatusControl";
import { ConnectorWiring } from "./ConnectorWiring";
import type { DeviceModelTargets } from "./DeviceModelTargets";
import { DeviceModelPublisher } from "./DeviceModelPublisher";
import type { MainMeter } from "./MainMeter";
import { MeterSampling } from "./MeterSampling";
import { OutageLifecycle } from "./OutageLifecycle";
import { PlugInFlow } from "./PlugInFlow";
import { PowerLossController } from "./PowerLossController";
import { ResetOnIdle } from "./ResetOnIdle";
import { ScenarioCallOwnership } from "./ScenarioCallOwnership";
import { StationMessaging } from "./StationMessaging";
import { StationNotifications } from "./StationNotifications";
import type { VehicleBehaviorDriver } from "./VehicleBehaviorDriver";
import type { ChargePointEvents } from "./ChargePointEvents";

/**
 * What the charge point hands the collaborators: its private state, each
 * member read through a function because the fields behind them are assigned
 * after the collaborators are built or are reassigned later. The collaborator
 * hosts take the members they need from it.
 */
export interface StationContext {
  readonly authorization: () => StationAuthorization;
  readonly callCatalog: () => OcppCallActions | null;
  readonly cellular: () => CellularLinkController;
  readonly certificateStore: () => CertificateStore;
  readonly clock: () => SimClock;
  readonly clockAligned: () => ClockAlignedMeterScheduler;
  readonly configuration: () => ConfigurationStore;
  readonly connectors: () => Map<number, Connector>;
  readonly deviceModelTargets: () => DeviceModelTargets;
  readonly engine: () => ChargePointEngine;
  readonly events: () => EventEmitter<ChargePointEvents>;
  readonly heartbeat: () => ChargePointHeartbeat;
  readonly localAuthListManager: () => LocalAuthListManager;
  readonly logSink: () => LogSink;
  readonly logger: () => Logger;
  readonly mainMeter: () => MainMeter | undefined;
  readonly monitoring: () => MonitoringStore;
  readonly monitorEvaluation: () => MonitorEvaluation | undefined;
  readonly networkProfiles: () => NetworkProfileStore;
  readonly nowDate: () => Date;
  readonly ocppVersion: () => string;
  readonly outbox: () => Outbox;
  readonly rawFrames: () => RawFrameSink | null;
  readonly reconnectPolicy: () => ReconnectPolicy;
  readonly repositories: () => ChargePointRepositories;
  readonly reservationManager: () => ReservationManager;
  readonly stateManager: () => ChargePointStateManager;
  readonly stationProfiles: () => ChargingProfileStore;
  readonly status: () => ChargePointStatus;
  readonly setStatus: (status: ChargePointStatus) => void;
  readonly timelineProjector: () => ChargePointTimelineProjector;
  readonly topology: () => StationTopology;
  readonly txEndedAligned: () => ClockAlignedMeterScheduler;
  readonly vehicleDrivers: () => Map<number, VehicleBehaviorDriver>;
  readonly webSocket: () => ChargePointSocket | null;
  readonly assertPowered: () => void;
  readonly evseIdOf: (connectorId: number) => number;
  readonly loadAvailability: (connectorId: number) => OCPPAvailability | null;
  readonly warnCapabilityProfileConflicts: () => void;
  readonly writeConnector: (connectorId: number, write: ConnectorWrite) => void;
}

/** The collaborators a charge point delegates to. */
export interface ChargePointCollaborators {
  readonly authorizationFlow: AuthorizationFlow;
  readonly boot: BootLifecycle;
  readonly bootState: BootStateStore;
  readonly callOverrides: CallOverrides;
  readonly certSwitch: ClientCertificateSwitch;
  readonly configWiring: ConfigurationWiring;
  readonly connectionTimeouts: ConnectionTimeouts;
  readonly connectorWiring: ConnectorWiring;
  readonly deviceModel: DeviceModelPublisher;
  readonly messaging: StationMessaging;
  readonly notifications: StationNotifications;
  readonly outage: OutageLifecycle;
  readonly plugIn: PlugInFlow;
  readonly power: PowerLossController;
  readonly profileControl: ChargingProfileControl;
  readonly resetOnIdle: ResetOnIdle;
  readonly sampling: MeterSampling;
  readonly scenarioCalls: ScenarioCallOwnership;
  readonly statusControl: ConnectorStatusControl;
}

/**
 * Build the collaborators of `cp`. Every host closure reads its target
 * lazily, through `ctx` or through the collaborators built here, so the
 * order of the entries below does not matter; none of the constructors
 * reads a host member.
 */
export function createCollaborators(
  cp: ChargePoint,
  ctx: StationContext,
): ChargePointCollaborators {
  const bootState = new BootStateStore();
  const c: ChargePointCollaborators = {
    authorizationFlow: new AuthorizationFlow({ ...ctx, chargePoint: cp }),
    bootState,
    boot: new BootLifecycle({
      ...ctx,
      chargePoint: cp,
      state: bootState,
      clearOutage: () => c.outage.clearOutage(),
      power: () => c.power,
    }),
    callOverrides: new CallOverrides(),
    certSwitch: new ClientCertificateSwitch({
      ...ctx,
      reset: () => cp.reset(),
    }),
    configWiring: new ConfigurationWiring({
      ...ctx,
      chargePoint: () => cp,
      rearmPeriodicSampling: () => c.sampling.rearmPeriodicSampling(),
    }),
    connectionTimeouts: new ConnectionTimeouts({ ...ctx, chargePoint: cp }),
    connectorWiring: new ConnectorWiring({
      ...ctx,
      chargePoint: cp,
      authorizationFlow: () => c.authorizationFlow,
      sampling: () => c.sampling,
    }),
    deviceModel: new DeviceModelPublisher(ctx),
    messaging: new StationMessaging({ ...ctx, chargePoint: cp }),
    notifications: new StationNotifications(ctx),
    outage: new OutageLifecycle({
      ...ctx,
      chargePoint: cp,
      state: bootState,
      boot: () => c.boot,
      callOverrides: () => c.callOverrides,
      certSwitch: () => c.certSwitch,
      connectionTimeouts: () => c.connectionTimeouts,
      power: () => c.power,
      sampling: () => c.sampling,
      scenarioCalls: () => c.scenarioCalls,
    }),
    plugIn: new PlugInFlow({
      ...ctx,
      chargePoint: cp,
      connectionTimeouts: () => c.connectionTimeouts,
    }),
    power: new PowerLossController({
      ...ctx,
      chargePoint: cp,
      markStartupEventPending: () => {
        c.boot.startupEventPending = true;
      },
      teardownAfterClose: () => c.outage.teardownAfterClose(),
    }),
    profileControl: new ChargingProfileControl({ ...ctx, chargePoint: cp }),
    resetOnIdle: new ResetOnIdle({
      ...ctx,
      chargePoint: cp,
      markStartupEventPending: () => {
        c.boot.startupEventPending = true;
      },
    }),
    sampling: new MeterSampling({ ...ctx, chargePoint: cp }),
    scenarioCalls: new ScenarioCallOwnership(ctx),
    statusControl: new ConnectorStatusControl({
      ...ctx,
      chargePoint: cp,
      connectionTimeouts: () => c.connectionTimeouts,
    }),
  };
  return c;
}
