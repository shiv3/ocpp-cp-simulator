/**
 * The runtime layer's contracts (#916): what the CLI and the daemon need from
 * the JavaScript runtime they run on. `./index.ts` picks the Bun or the Node
 * implementation once, at startup; nothing else in the CLI touches `Bun.*`
 * or runtime-specific server APIs.
 */
import type { Server as SocketIoServer } from "socket.io";

/** The listener `serve()` hands back and passes to every request handler. */
export interface RuntimeServer {
  /** Port actually bound (resolved when `0` was asked for). */
  readonly port: number | undefined;
  /** Peer address of the TCP connection `req` arrived on; null when unknown. */
  requestIP(req: Request): { readonly address: string } | null;
  /**
   * Stop accepting connections. `closeActiveConnections` also drops the ones
   * that are open, WebSocket upgrades included. Fire-and-forget.
   */
  stop(closeActiveConnections?: boolean): unknown;
}

/**
 * A fetch-style request handler. `undefined` means the request was taken over
 * (a WebSocket upgrade) and needs no response.
 */
export type FetchHandler = (
  req: Request,
  server: RuntimeServer,
) => Response | undefined | Promise<Response | undefined>;

export interface ServeOptions {
  readonly port: number;
  readonly hostname: string;
  readonly fetch: FetchHandler;
  /**
   * The Socket.IO engine whose requests `fetch` forwards (see
   * {@link SocketIoEngine.handleRequest}); it brings its WebSocket handling.
   */
  readonly socketIo?: SocketIoEngine | null;
}

/** Engine.IO options the daemon sets; the same for both runtimes. */
export interface SocketIoEngineOptions {
  readonly path: string;
  readonly pingInterval: number;
  readonly pingTimeout: number;
  readonly maxHttpBufferSize: number;
}

/**
 * The Engine.IO side of a Socket.IO server, bound to `io`. The HTTP handler
 * routes Socket.IO paths to {@link handleRequest} after its own checks (access
 * guard, origin allowlist), so both runtimes gate them the same way.
 */
export interface SocketIoEngine {
  /** Seconds a connection may idle; at least one ping interval. */
  readonly idleTimeout: number;
  /**
   * Bun only: the `websocket` handler `Bun.serve` needs for upgrades. Absent
   * on Node, where upgrades arrive on the http.Server's `upgrade` event.
   */
  readonly websocket?: unknown;
  handleRequest(req: Request, server: RuntimeServer): Promise<Response>;
  close(): void;
}

export interface SpawnOptions {
  readonly cmd: string[];
  readonly env: Record<string, string | undefined>;
}

/**
 * A child process with stdin ignored and stdout / stderr piped. `spawn` throws
 * an error with `code: "ENOENT"` synchronously when the executable is not
 * found, on both runtimes.
 */
export interface SpawnedProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves with the exit code; null when the process ended on a signal. */
  readonly exited: Promise<number | null>;
  kill(): void;
}

/** A file on disk served as an HTTP response body. */
export interface RuntimeFile {
  /** True for an existing regular file (false for a directory). */
  exists(): Promise<boolean>;
  /** A 200 response with the file's bytes and a content-type from its extension. */
  response(): Promise<Response>;
}

export interface Runtime {
  readonly name: "bun" | "node";
  serve(options: ServeOptions): Promise<RuntimeServer>;
  createSocketIoEngine(
    io: SocketIoServer,
    options: SocketIoEngineOptions,
  ): SocketIoEngine;
  spawn(options: SpawnOptions): SpawnedProcess;
  file(path: string): RuntimeFile;
}
