import type { OcppSecurityProfile } from "@ocpp-cp-simulator/contracts/securityProfile";
import type { Logger } from "../../shared/Logger";
import type { LogSink } from "../persistence/LogSink";
import type { OcppTlsOptions } from "../transport/ConnectionSecurity";
import type { ChargePointSocket } from "../transport/ChargePointSocket";
import type { IChargePointMessageHandler } from "../transport/IChargePointMessageHandler";
import type { OcppCallActions } from "../transport/OcppCallActions";
import type { RawFrameSink } from "../transport/RawFrameSink";
import type {
  BasicAuthSettings,
  ChargePoint,
  ChargePointTransportOptions,
} from "./ChargePoint";
import type { FileUploader } from "./FileUploader";

/**
 * What a {@link ChargePoint} is built with from outside the domain (#575).
 * `infrastructure/charge-point/createChargePoint` provides the defaults.
 */
export interface ChargePointDeps {
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
