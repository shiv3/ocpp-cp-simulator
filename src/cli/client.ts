import {
  io as createSocketClient,
  type ManagerOptions,
  type Socket,
  type SocketOptions,
} from "socket.io-client";

import {
  RPC_TIMEOUT_MS,
  rpcAckSchema,
  type EventEnvelope,
  type RpcAck,
} from "../protocol";
import { toJsonResponse } from "./output";
import type { JsonCommand } from "./types";

export interface ClientLocation {
  readonly httpUrl: string;
  /** Basic Auth credentials to send to a daemon started with
   *  `--web-console-basic-auth-*`. Null/omitted = no socket handshake auth
   *  (the daemon must then be running without the auth gate). */
  readonly basicAuth?: {
    readonly username: string;
    readonly password: string;
  } | null;
}

export async function sendCommand(
  loc: ClientLocation,
  cpId: string,
  jsonStr: string,
): Promise<void> {
  let cmd: JsonCommand;
  try {
    cmd = JSON.parse(jsonStr) as JsonCommand;
  } catch {
    process.stderr.write("Error: --send value must be valid JSON\n");
    process.exit(1);
  }
  if (!isJsonCommand(cmd)) {
    process.stdout.write(
      `${JSON.stringify(toJsonResponse(null, false, "Invalid JsonCommand"))}\n`,
    );
    return;
  }

  const socket = createClientSocket(loc);
  try {
    await connect(socket);
    const ack = await emitRpc(socket, {
      cpId,
      method: cmd.command,
      params: cmd.params ?? {},
    });
    const id = cmd.id ?? null;
    if (ack.ok) {
      process.stdout.write(
        `${JSON.stringify(toJsonResponse(id, true, ack.result))}\n`,
      );
    } else {
      process.stdout.write(
        `${JSON.stringify(toJsonResponse(id, false, ack.error.message))}\n`,
      );
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`Error: ${formatSocketError(err, loc)}\n`);
    process.exitCode = 1;
  } finally {
    socket.disconnect();
  }
}

export async function stopDaemon(loc: ClientLocation): Promise<void> {
  const socket = createClientSocket(loc);
  try {
    await connect(socket);
    const ack = await emitRpc(socket, {
      method: "server.shutdown",
      params: {},
    });
    if (ack.ok) {
      process.stdout.write("Server stopped.\n");
    } else {
      process.stderr.write(`Error: ${ack.error.message}\n`);
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`Error: ${formatSocketError(err, loc)}\n`);
    process.exitCode = 1;
  } finally {
    socket.disconnect();
  }
}

export async function subscribeEvents(
  loc: ClientLocation,
  cpId: string | null,
): Promise<void> {
  const socket = createClientSocket(loc);
  const scope = cpId ?? "*";
  await new Promise<void>((resolve) => {
    socket.on("connect", () => {
      socket.emit("events.subscribe", { scope }, (ack: unknown) => {
        if (isDirectErrorAck(ack)) {
          process.stderr.write(`Error: ${ack.message}\n`);
          process.exitCode = 1;
          socket.disconnect();
          return;
        }
        process.stderr.write(
          `[client] Subscribed to ${loc.httpUrl} (${scope})\n`,
        );
      });
    });
    socket.on("event", (event: EventEnvelope) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    });
    socket.on("connect_error", (err) => {
      process.stderr.write(`Error: ${formatSocketError(err, loc)}\n`);
      process.exitCode = 1;
      socket.disconnect();
      resolve();
    });
    socket.on("disconnect", () => {
      resolve();
    });

    const close = () => {
      socket.disconnect();
    };
    const cleanupSignals = () => {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
    socket.once("disconnect", cleanupSignals);
    socket.connect();
  });
}

function createClientSocket(loc: ClientLocation): Socket {
  return createSocketClient(loc.httpUrl, {
    path: "/socket.io/",
    reconnection: false,
    timeout: RPC_TIMEOUT_MS,
    autoConnect: false,
    ...authOption(loc.basicAuth ?? null),
  } satisfies Partial<ManagerOptions & SocketOptions>);
}

function authOption(
  basicAuth: ClientLocation["basicAuth"],
): Pick<SocketOptions, "auth"> | Record<string, never> {
  return basicAuth
    ? {
        auth: {
          username: basicAuth.username,
          password: basicAuth.password,
        },
      }
    : {};
}

function connect(socket: Socket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("connect_error", onConnectError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onConnectError = (err: Error) => {
      cleanup();
      reject(err);
    };
    socket.once("connect", onConnect);
    socket.once("connect_error", onConnectError);
    socket.connect();
  });
}

async function emitRpc(
  socket: Socket,
  request: { cpId?: string; method: string; params: unknown },
): Promise<RpcAck> {
  const rawAck = await socket
    .timeout(RPC_TIMEOUT_MS)
    .emitWithAck("rpc", request);
  const parsed = rpcAckSchema.safeParse(rawAck);
  if (!parsed.success) {
    throw new Error("invalid rpc ack");
  }
  return parsed.data;
}

function isJsonCommand(value: unknown): value is JsonCommand {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { command?: unknown }).command === "string"
  );
}

function isDirectErrorAck(
  ack: unknown,
): ack is { ok: false; code: string; message: string } {
  return (
    ack !== null &&
    typeof ack === "object" &&
    (ack as { ok?: unknown }).ok === false &&
    typeof (ack as { message?: unknown }).message === "string"
  );
}

function formatSocketError(err: unknown, loc: ClientLocation): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("xhr poll error") || message.includes("ECONNREFUSED")) {
    return `Cannot connect to ${loc.httpUrl}`;
  }
  return message;
}
