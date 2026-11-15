/**
 * What the collaborators split out of `OCPPWebSocket` (#877) reach of it: its
 * state, as properties that read and write the facade's own fields, and the
 * methods they call back. The fields stay on `OCPPWebSocket` (tests read them
 * there); the collaborators hold this object, never the facade itself.
 */
import type { Logger } from "../../../shared/Logger";
import type { WsClientOptions } from "../../../shared/WsClientOptions";
import type {
  ReconnectPolicy,
  RetryBackOffVariables,
} from "../../../shared/ReconnectPolicy";
import type {
  SocketClose,
  TransportObserverEvents,
} from "../../../domain/transport/ChargePointSocket";
import type { EventEmitter } from "../../../shared/EventEmitter";
import type {
  CloseCause,
  GenerationToken,
  NetworkSimController,
} from "../network-sim";
import type { SupervisionUrlPool } from "../SupervisionUrlPool";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
  OcppWebSocketConnectOptions,
  OcppSocket,
} from "../wsUrlWithBasic";
import type { ClientCertificateState } from "./clientCertificateState";
import type { GenerationTokenImpl } from "./closeClassification";
import type {
  IncomingFrameInterceptor,
  MessageHandler,
} from "../OCPPWebSocket";

/** The facade's fields, by name without the leading underscore. */
export interface OcppWebSocketFields {
  ws: OcppSocket | null;
  url: string;
  basicAuth: { username: string; password: string } | null;
  chargePointId: string;
  logger: Logger;
  messageHandler: MessageHandler | null;
  incomingInterceptor: IncomingFrameInterceptor | null;
  pingInterval: ReturnType<typeof setInterval> | null;
  pingIntervalSeconds: number;
  reconnectAttempts: number;
  reconnectPolicy: ReconnectPolicy;
  reconnectRandom: () => number;
  wsOptions: WsClientOptions;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  retryBackOff: RetryBackOffVariables | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  linkBlockedReason: string | null;
  resumeOnLinkRestore: boolean;
  onOpenCallback: (() => void) | null;
  onCloseCallback: ((ev: SocketClose, cause: CloseCause) => void) | null;
  isManualDisconnect: boolean;
  selfRequestedClose: boolean;
  lastConnectOptions: OcppWebSocketConnectOptions | null;
  lastRefusalProbeAt: number;
  refusalStatusReported: boolean;
  extraHeaders: Record<string, string>;
  extraSubprotocols: ReadonlyArray<string>;
  ocppVersion: string;
  securityProfile?: OcppSecurityProfile;
  authorizationKey?: string;
  securityProfileFallback: (() => void) | null;
  credentialsChangedAtRuntime: boolean;
  cpoName?: string;
  tls?: OcppTlsOptions;
  clientCerts: ClientCertificateState;
  connectionClientCertificate: string | undefined;
  controller: NetworkSimController;
  generationCounter: number;
  currentGeneration: GenerationTokenImpl;
  socketToken: GenerationTokenImpl | null;
  reconnectNotBefore: number | null;
  urlPool: SupervisionUrlPool | null;
  onCloseTransactionCallback: ((finalized: GenerationToken) => void) | null;
  observers: EventEmitter<TransportObserverEvents>;
  pendingReconnectNotice: { attempt: number; delayMs: number } | null;
  pendingGaveUp: { attempts: number } | null;
  disposed: boolean;
}

/** The facade's methods the collaborators call. Each goes through the facade
 *  (or the collaborator that owns it), so a spy on the facade still sees it. */
export interface OcppWebSocketCallbacks {
  isConnected(): boolean;
  connect(
    onopen?: (() => void) | null,
    onclose?: ((ev: SocketClose, cause: CloseCause) => void) | null,
  ): void;
  attemptReconnect(): void;
  startPingInterval(): void;
  stopPingInterval(): void;
  runCloseTransaction(closeCause: CloseCause): void;
  handleOpen(): void;
  handleError(evt: Event): void;
  handleClose(ev: CloseEvent, closeCause: CloseCause): void;
  closeCauseOf(token: GenerationToken): CloseCause;
  reportClose(token: GenerationTokenImpl, ev: SocketClose): void;
  clearHandshakeTimer(): void;
}

export type OcppWebSocketHost = OcppWebSocketFields & OcppWebSocketCallbacks;

/** Every key of {@link OcppWebSocketFields}, space separated. */
const FIELD_NAMES =
  "ws url basicAuth chargePointId logger messageHandler incomingInterceptor pingInterval pingIntervalSeconds reconnectAttempts reconnectPolicy reconnectRandom wsOptions handshakeTimer retryBackOff reconnectTimer linkBlockedReason resumeOnLinkRestore onOpenCallback onCloseCallback isManualDisconnect selfRequestedClose lastConnectOptions lastRefusalProbeAt refusalStatusReported extraHeaders extraSubprotocols ocppVersion securityProfile authorizationKey securityProfileFallback credentialsChangedAtRuntime cpoName tls clientCerts connectionClientCertificate controller generationCounter currentGeneration socketToken reconnectNotBefore urlPool onCloseTransactionCallback observers pendingReconnectNotice pendingGaveUp disposed".split(
    " ",
  ) as ReadonlyArray<keyof OcppWebSocketFields>;

/** `observers` is the one public field; the others are `_name`. */
function fieldKey(name: string): string {
  return name === "observers" ? name : `_${name}`;
}

/**
 * Builds the host over `owner`'s fields: reading or writing
 * `host.reconnectAttempts` is reading or writing `owner._reconnectAttempts`,
 * so a moved body keeps its statements (`host.reconnectAttempts++`).
 */
export function createHost(
  owner: object,
  callbacks: OcppWebSocketCallbacks,
): OcppWebSocketHost {
  const fields = owner as Record<string, unknown>;
  const host = { ...callbacks } as OcppWebSocketHost;
  for (const name of FIELD_NAMES) {
    Object.defineProperty(host, name, {
      enumerable: true,
      get: () => fields[fieldKey(name)],
      set: (value: unknown) => {
        fields[fieldKey(name)] = value;
      },
    });
  }
  return host;
}
