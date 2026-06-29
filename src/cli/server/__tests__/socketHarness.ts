import type { Server as BunServer } from "bun";
import { createServer as createNetServer } from "node:net";
import {
  io as createSocketClient,
  type ManagerOptions,
  type Socket,
  type SocketOptions,
} from "socket.io-client";

import type { Database } from "../../../cp/domain/persistence/Database";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createHttpHandlers, type CorsPolicy } from "../httpServer";
import { createLifecycle } from "../lifecycle";
import {
  attachSocketIo,
  isSocketIoPath,
  SOCKET_IO_PATH,
  type SocketIoAttachment,
} from "../socketServer";

export interface TestServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly cors?: CorsPolicy;
  readonly database?: Database | null;
  readonly healthPath?: string;
  readonly staticDir?: string | null;
  readonly webConsoleBasicAuth?: {
    readonly username: string;
    readonly password: string;
  } | null;
  readonly insecureTlsKeyPerms?: boolean;
}

export interface TestServer {
  readonly bus: EventBus;
  readonly registry: CPRegistry;
  readonly server: BunServer<Record<string, unknown>>;
  readonly socketIo: SocketIoAttachment;
  readonly url: string;
  readonly port: number;
  readonly restored: ReadonlyArray<string>;
  close(): Promise<void>;
}

export type TestClientOptions = Partial<ManagerOptions & SocketOptions>;

export async function startTestServer(
  options: TestServerOptions = {},
): Promise<TestServer> {
  const host = options.host ?? "127.0.0.1";
  const bus = new EventBus();
  const database = options.database ?? null;
  const registry = new CPRegistry(bus, database, {
    allowInsecureTlsKeyPerms: options.insecureTlsKeyPerms ?? false,
  });
  const restored = await Promise.resolve(registry.restoreFromDatabase());
  let lifecycle: ReturnType<typeof createLifecycle> | null = null;
  const socketIo = attachSocketIo({
    registry,
    bus,
    database,
    webConsoleBasicAuth: options.webConsoleBasicAuth ?? null,
    requestShutdown: () => {
      lifecycle?.requestShutdown();
    },
  });
  lifecycle = createLifecycle({
    pidPath: null,
    registry,
    onShutdownStart: () => {
      void socketIo.close();
    },
  });
  const handlers = createHttpHandlers({
    registry,
    bus,
    lifecycle,
    cors: options.cors ?? { kind: "any" },
    database,
    healthPath: options.healthPath ?? "/v1/healthz",
    staticDir: options.staticDir ?? null,
    webConsoleBasicAuth: options.webConsoleBasicAuth ?? null,
    socketIo: {
      matches: isSocketIoPath,
      handleRequest: socketIo.handleRequest,
    },
  });

  const port =
    options.port && options.port > 0
      ? options.port
      : await pickEphemeralPort(host);
  const server = Bun.serve({
    hostname: host,
    port,
    fetch: handlers.fetch,
    idleTimeout: socketIo.idleTimeout,
    websocket: socketIo.websocket,
  });
  const url = `http://${host}:${server.port}`;
  let closed = false;

  return {
    bus,
    registry,
    server,
    socketIo,
    url,
    port: server.port ?? 0,
    restored,
    async close() {
      if (closed) return;
      closed = true;
      await closeSocketIo(socketIo);
      server.stop(true);
      registry.shutdownAll();
    },
  };
}

export function createTestClient(
  target: TestServer | string,
  options: TestClientOptions = {},
): Socket {
  const url = typeof target === "string" ? target : target.url;
  return createSocketClient(url, {
    path: SOCKET_IO_PATH,
    reconnection: false,
    timeout: 2_000,
    ...options,
  });
}

export async function connectTestClient(
  target: TestServer | string,
  options: TestClientOptions = {},
): Promise<Socket> {
  const socket = createTestClient(target, options);
  try {
    await waitForSocketEvent(socket, "connect", 2_000);
    return socket;
  } catch (err) {
    socket.disconnect();
    throw err;
  }
}

export function waitForSocketEvent(
  socket: Socket,
  event: string,
  timeoutMs = 2_000,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`socket event "${event}" timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    const onEvent = (...args: unknown[]) => {
      cleanup();
      resolve(args);
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, onEvent);
      socket.off("connect_error", onError);
    };
    socket.once(event, onEvent);
    if (event !== "connect_error") {
      socket.once("connect_error", onError);
    }
  });
}

function closeSocketIo(socketIo: SocketIoAttachment): Promise<void> {
  return Promise.race([
    socketIo.close(),
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
}

function pickEphemeralPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("failed to allocate an ephemeral TCP port"));
        return;
      }
      const port = address.port;
      probe.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}
