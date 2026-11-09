import type { OcppSecurityProfile } from "@ocpp-cp-simulator/contracts/securityProfile";
import type { EventEmitter } from "../../shared/EventEmitter";
import type { Logger } from "../../shared/Logger";
import type { SimClock } from "../../shared/clock";
import type { Rng } from "../../shared/rng";
import type { Connector } from "../connector/Connector";
import type {
  BehaviorRegistryOptions,
  ChargePointBehaviorRegistry,
} from "../engine/behaviorRules";
import type {
  ChargePointEngine,
  TransactionPorts,
} from "../engine/ChargePointEngine";
import type { LogSink } from "../persistence/LogSink";
import type { ChargePointHeartbeat } from "../services/ChargePointHeartbeat";
import type { ChargePointStateManager } from "../services/ChargePointStateManager";
import type {
  ChargePointTimeline,
  ChargePointTimelineProjector,
} from "../services/ChargePointTimeline";
import type { OcppTlsOptions } from "../transport/ConnectionSecurity";
import type { ChargePointSocket } from "../transport/ChargePointSocket";
import type { IChargePointMessageHandler } from "../transport/IChargePointMessageHandler";
import type { OcppCallActions } from "../transport/OcppCallActions";
import type { RawFrameSink } from "../transport/RawFrameSink";
import type { StopTransactionReason } from "../connector/Transaction";
import type { ChargePointStatus } from "../types/OcppTypes";
import type {
  BasicAuthSettings,
  ChargePoint,
  ChargePointTransportOptions,
  StartTransactionOptions,
  StartTransactionOutcome,
  StopTransactionOptions,
} from "./ChargePoint";
import type { ChargePointEvents } from "./ChargePointEvents";
import type { FileUploader } from "./FileUploader";

/**
 * The services a {@link ChargePoint} is built with (#575). The domain names
 * them by interface; `infrastructure/charge-point/createDefaultServices`
 * binds them to the application classes. Each factory is called once, from
 * inside the constructor.
 */
export interface ChargePointServiceFactories {
  /**
   * Builds the behavior registry. Called first, right after the clock is
   * set: the engine and the message handlers read it when they are built.
   */
  createBehaviorRegistry(
    options: BehaviorRegistryOptions,
  ): ChargePointBehaviorRegistry;
  /**
   * Builds the charger engine, right after the registry and before the
   * connectors are attached. It registers the default behaviors and reads
   * nothing else from `cp` while it is built.
   */
  createEngine(cp: ChargePoint): ChargePointEngine;
  /**
   * Builds the heartbeat once the outbox exists; the charge point then
   * installs the callback that sends a Heartbeat.req.
   */
  createHeartbeat(logger: Logger, clock: SimClock): ChargePointHeartbeat;
  /** Builds the state history recorder, once the connectors exist. */
  createStateManager(ctx: StateManagerContext): ChargePointStateManager;
  /**
   * Builds the operational timeline and the projector that feeds it from
   * the charge point's events. Called before any connection or status
   * event can fire: the projector subscribes when it is built.
   */
  createTimeline(ctx: TimelineContext): {
    readonly timeline: ChargePointTimeline;
    readonly projector: ChargePointTimelineProjector;
  };
  /** The default transaction behavior the public transaction methods run. */
  transactions: ChargePointTransactions;
}

/** What the state history recorder reads from its charge point. */
export interface StateManagerContext {
  readonly logger: Logger;
  readonly events: EventEmitter<ChargePointEvents>;
  /** The charge point's own status and error, read on each transition. */
  readonly chargePoint: () => { status: ChargePointStatus; error: string };
  readonly clock: SimClock;
  /** The charge point's `state-history` random stream (entry ids). */
  readonly rng: Rng;
}

/** What the timeline and its projector read from their charge point. */
export interface TimelineContext {
  readonly cpId: string;
  readonly events: EventEmitter<ChargePointEvents>;
  /** The live connector map: the projector reads it on each event. */
  readonly connectors: ReadonlyMap<number, Connector>;
  readonly clock: SimClock;
  /** The charge point's `timeline` random stream (entry ids). */
  readonly rng: Rng;
}

/**
 * The default transaction behavior (application/engine/behaviors/
 * transaction.ts). The charge point checks it is powered, then hands the
 * call over with the ports it builds (lazy: the outbox is set later).
 */
export interface ChargePointTransactions {
  start(
    cp: ChargePoint,
    ports: TransactionPorts,
    tagId: string,
    connectorId: number,
    batteryCapacityKwh: number | undefined,
    initialSoc: number | undefined,
    options: StartTransactionOptions,
  ): Promise<StartTransactionOutcome>;
  stop(
    cp: ChargePoint,
    ports: TransactionPorts,
    connectorOrId: number | Connector,
    reason: StopTransactionReason | undefined,
    options: StopTransactionOptions,
  ): void;
  clean(cp: ChargePoint, connectorOrId: Connector | number): void;
}

/**
 * What a {@link ChargePoint} is built with from outside the domain (#575).
 * `infrastructure/charge-point/createChargePoint` provides the defaults.
 */
export interface ChargePointDeps extends ChargePointServiceFactories {
  /**
   * Builds the transport. Called once, from inside the constructor, after
   * the connectors exist and before the configuration store is built: the
   * message handlers read the charge point (`clock`, `id`, `database`,
   * `behaviors`) when they are constructed. The charge point then sets the
   * reconnect policy, the WS client options and its observers on the socket.
   */
  createTransport(cp: ChargePoint, ctx: TransportContext): ChargePointTransport;
  /**
   * Persists the charge point's log entries; owned by this charge point,
   * flushed on `flushLogs` and on a transport close, closed on `dispose`.
   */
  logSink: LogSink;
  /** Uploads the GetDiagnostics file (read when an upload starts). */
  fileUploader: FileUploader;
}

/** The constructor arguments and resolved state the transport is built from. */
export interface TransportContext {
  readonly logger: Logger;
  /** The first supervision URL (OCPP-J) as given to the constructor. */
  readonly wsUrl: string;
  /** `transportOptions.centralSystemUrl`, else `wsUrl`. */
  readonly transportUrl: string;
  readonly basicAuth: BasicAuthSettings | null;
  readonly extraWsHeaders: Record<string, string>;
  readonly extraWsSubprotocols: ReadonlyArray<string>;
  readonly ocppVersion: string;
  readonly securityProfile: OcppSecurityProfile | undefined;
  readonly authorizationKey: string | undefined;
  readonly cpoName: string | undefined;
  readonly tls: OcppTlsOptions | undefined;
  readonly transportOptions: ChargePointTransportOptions;
}

/** A charge point's transport, as its factory returns it. */
export interface ChargePointTransport {
  /** The OCPP-J socket; `null` is the SOAP signal. */
  readonly socket: ChargePointSocket | null;
  /** #393 expert raw frames; `null` on SOAP. */
  readonly rawFrames: RawFrameSink | null;
  readonly handler: IChargePointMessageHandler;
  /** #389 expert OCPP calls; `null` on SOAP. */
  readonly callCatalog: OcppCallActions | null;
  /**
   * SOAP: whether the version's dialect dispatches `action` to the charge
   * point (target `cp`, or a bidirectional operation). `null` on OCPP-J,
   * which receives every CSMS call.
   */
  receivesCsmsCall(action: string): boolean | null;
}
