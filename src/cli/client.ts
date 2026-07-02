import type { EventEnvelope } from "../protocol";
import { RemoteChargePointService } from "../data/remote/RemoteChargePointService";
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

  const service = createRemoteService(loc);
  try {
    const ack = await service.runRawRpc(cmd.command, cmd.params ?? {}, cpId);
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
    service.dispose();
  }
}

export async function stopDaemon(loc: ClientLocation): Promise<void> {
  const service = createRemoteService(loc);
  try {
    const ack = await service.runRawRpc("server.shutdown", {});
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
    service.dispose();
  }
}

export async function subscribeEvents(
  loc: ClientLocation,
  cpId: string | null,
): Promise<void> {
  const service = createRemoteService(loc);
  const scope = cpId ?? "*";
  let subscribed = false;

  await new Promise<void>((resolve) => {
    let done = false;
    let unsubscribeConnection = () => {};

    const finish = () => {
      if (done) return;
      done = true;
      cleanupSignals();
      unsubscribeConnection();
      service.dispose();
      resolve();
    };

    const close = () => {
      finish();
    };
    const cleanupSignals = () => {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
    };

    process.on("SIGINT", close);
    process.on("SIGTERM", close);

    unsubscribeConnection = service.onConnectionChange((state) => {
      if (state === "disconnected" && subscribed) {
        finish();
      }
    });

    void service
      .subscribeRawEvents(scope, (event: EventEnvelope) => {
        if (done) return;
        process.stdout.write(`${JSON.stringify(event)}\n`);
      })
      .then(
        () => {
          if (done) return;
          subscribed = true;
          process.stderr.write(
            `[client] Subscribed to ${loc.httpUrl} (${scope})\n`,
          );
        },
        (err) => {
          if (done) return;
          process.stderr.write(`Error: ${formatSocketError(err, loc)}\n`);
          process.exitCode = 1;
          finish();
        },
      );
  });
}

function isJsonCommand(value: unknown): value is JsonCommand {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { command?: unknown }).command === "string"
  );
}

function createRemoteService(loc: ClientLocation): RemoteChargePointService {
  return new RemoteChargePointService(loc.httpUrl, {
    basicAuth: loc.basicAuth ?? null,
  });
}

function formatSocketError(err: unknown, loc: ClientLocation): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("xhr poll error") || message.includes("ECONNREFUSED")) {
    return `Cannot connect to ${loc.httpUrl}`;
  }
  return message;
}
