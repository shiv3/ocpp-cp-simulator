/**
 * The Bun implementation of the runtime layer (#916). Exactly what the CLI
 * did before the layer existed: `Bun.serve` with `@socket.io/bun-engine`,
 * `Bun.spawn`, `Bun.file`. `Bun` is only read inside the functions, so this
 * module loads on Node too (it is never called there).
 */
import { Server as BunEngine } from "@socket.io/bun-engine";
import type { Server as BunServer, WebSocketHandler } from "bun";
import type {
  Runtime,
  RuntimeServer,
  SocketIoEngine,
  SpawnedProcess,
} from "./types";

/** The `websocket` option of `Bun.serve` the Socket.IO engine provides. */
export type BunWebSocketHandler = WebSocketHandler<Record<string, unknown>>;

export const bunRuntime: Runtime = {
  name: "bun",

  serve(options) {
    // The Bun server itself is the RuntimeServer: the bun engine needs the
    // real object (it calls `server.upgrade`).
    const fetch = options.fetch as (
      req: Request,
      server: BunServer<Record<string, unknown>>,
    ) => Response | Promise<Response>;
    const socketIo = options.socketIo;
    const server = socketIo
      ? Bun.serve({
          port: options.port,
          hostname: options.hostname,
          fetch,
          idleTimeout: socketIo.idleTimeout,
          websocket: socketIo.websocket as BunWebSocketHandler,
        })
      : Bun.serve({
          port: options.port,
          hostname: options.hostname,
          fetch,
        });
    return Promise.resolve(server as RuntimeServer);
  },

  createSocketIoEngine(io, options): SocketIoEngine {
    const engine = new BunEngine({
      path: options.path,
      pingInterval: options.pingInterval,
      pingTimeout: options.pingTimeout,
      maxHttpBufferSize: options.maxHttpBufferSize,
    });
    io.bind(engine);
    const handler = engine.handler();
    return {
      idleTimeout: Math.max(
        handler.idleTimeout,
        Math.floor(options.pingInterval / 1_000) + 1,
      ),
      websocket: handler.websocket,
      handleRequest(req, server) {
        return engine.handleRequest(req, server as never);
      },
      close() {
        engine.close();
      },
    };
  },

  spawn(options): SpawnedProcess {
    const proc = Bun.spawn({
      cmd: options.cmd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited: proc.exited,
      kill: () => proc.kill(),
    };
  },

  file(path) {
    const file = Bun.file(path);
    return {
      exists: () => file.exists(),
      response: () => Promise.resolve(new Response(file)),
    };
  },
};
