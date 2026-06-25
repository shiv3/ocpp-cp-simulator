import type {
  Server as BunServer,
  ServerWebSocket,
  WebSocketHandler,
} from "bun";
import { Server as Engine } from "@socket.io/bun-engine";
import { Server as SocketIoServer } from "socket.io";

import { MAX_HTTP_BUFFER } from "../../protocol";
import type { HttpHandlers } from "./httpServer";

export const SOCKET_IO_PATH = "/socket.io/";
export const SOCKET_IO_PING_INTERVAL_MS = 25_000;
export const SOCKET_IO_PING_TIMEOUT_MS = 20_000;

type SocketIoWebSocketData = { transport?: unknown };
type AnyWebSocket = ServerWebSocket<Record<string, unknown>>;
type AnyWebSocketHandler = WebSocketHandler<Record<string, unknown>>;

export interface SocketIoAttachment {
  readonly io: SocketIoServer;
  readonly engine: Engine;
  readonly websocket: AnyWebSocketHandler;
  readonly idleTimeout: number;
  handleRequest(
    req: Request,
    server: BunServer<Record<string, unknown>>,
  ): Promise<Response>;
  close(): Promise<void>;
}

export function isSocketIoPath(pathname: string): boolean {
  return pathname === "/socket.io" || pathname.startsWith(SOCKET_IO_PATH);
}

export function attachSocketIo(): SocketIoAttachment {
  const io = new SocketIoServer({
    serveClient: false,
    maxHttpBufferSize: MAX_HTTP_BUFFER,
    pingInterval: SOCKET_IO_PING_INTERVAL_MS,
    pingTimeout: SOCKET_IO_PING_TIMEOUT_MS,
  });
  const engine = new Engine({
    path: SOCKET_IO_PATH,
    pingInterval: SOCKET_IO_PING_INTERVAL_MS,
    pingTimeout: SOCKET_IO_PING_TIMEOUT_MS,
    maxHttpBufferSize: MAX_HTTP_BUFFER,
  });

  io.bind(engine);
  io.on("connection", () => {
    // Task 4 only mounts socket.io. RPC/auth/event handlers are registered in
    // later migration tasks, but the connection listener is attached after DB
    // restore so accepted sockets observe restored state.
  });

  const handler = engine.handler();
  const idleTimeout = Math.max(
    handler.idleTimeout,
    Math.floor(SOCKET_IO_PING_INTERVAL_MS / 1_000) + 1,
  );

  return {
    io,
    engine,
    websocket: handler.websocket as AnyWebSocketHandler,
    idleTimeout,
    handleRequest(req, server) {
      return engine.handleRequest(req, server as never);
    },
    close() {
      engine.close();
      return new Promise((resolve) => {
        io.close(() => resolve());
      });
    },
  };
}

export function combineWebSocketHandlers(
  socketIoHandler: AnyWebSocketHandler,
  legacyHandler: HttpHandlers["websocket"],
): AnyWebSocketHandler {
  return {
    maxPayloadLength: socketIoHandler.maxPayloadLength,
    open(ws) {
      if (isSocketIoWebSocket(ws)) {
        return socketIoHandler.open?.(ws);
      }
      return legacyHandler.open?.(ws as never);
    },
    message(ws, message) {
      if (isSocketIoWebSocket(ws)) {
        return socketIoHandler.message(ws, message);
      }
      return legacyHandler.message(ws as never, message);
    },
    close(ws, code, reason) {
      if (isSocketIoWebSocket(ws)) {
        return socketIoHandler.close?.(ws, code, reason);
      }
      return legacyHandler.close?.(ws as never, code, reason);
    },
    drain(ws) {
      if (isSocketIoWebSocket(ws)) {
        return socketIoHandler.drain?.(ws);
      }
      return legacyHandler.drain?.(ws as never);
    },
    ping(ws, data) {
      if (isSocketIoWebSocket(ws)) {
        return socketIoHandler.ping?.(ws, data);
      }
      return legacyHandler.ping?.(ws as never, data);
    },
    pong(ws, data) {
      if (isSocketIoWebSocket(ws)) {
        return socketIoHandler.pong?.(ws, data);
      }
      return legacyHandler.pong?.(ws as never, data);
    },
  };
}

function isSocketIoWebSocket(
  ws: AnyWebSocket,
): ws is ServerWebSocket<SocketIoWebSocketData> {
  return Boolean((ws.data as SocketIoWebSocketData | undefined)?.transport);
}
