/**
 * The Socket.IO engine on Node (#916): the stock Engine.IO server that
 * `socket.io` creates for a Node `http.Server`.
 *
 * `io.attach()` is given a private http.Server that never listens: it is only
 * the handle socket.io builds its Engine.IO server from. The daemon's real
 * listeners route Socket.IO paths through their fetch handler first (access
 * guard, origin allowlist, CORS headers — the same as on Bun) and then hand
 * the raw request or upgrade to `io.engine` (see `handOff` in `./serve`).
 */
import { createServer } from "node:http";
import type { Server as SocketIoServer } from "socket.io";
import type { SocketIoEngine, SocketIoEngineOptions } from "../types";
import { handOff } from "./serve";

export function createNodeSocketIoEngine(
  io: SocketIoServer,
  options: SocketIoEngineOptions,
): SocketIoEngine {
  io.attach(createServer(), {
    path: options.path,
    pingInterval: options.pingInterval,
    pingTimeout: options.pingTimeout,
    maxHttpBufferSize: options.maxHttpBufferSize,
  });
  const engine = io.engine;
  return {
    idleTimeout: Math.floor(options.pingInterval / 1_000) + 1,
    handleRequest() {
      return Promise.resolve(
        handOff((raw) => {
          if (raw.kind === "upgrade") {
            engine.handleUpgrade(raw.req, raw.socket, raw.head);
          } else {
            engine.handleRequest(raw.req, raw.res);
          }
        }),
      );
    },
    close() {
      engine.close();
    },
  };
}
