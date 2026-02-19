import * as net from "net";
import { getSocketPath } from "./daemon";

const CLIENT_TIMEOUT_MS = 10_000;

function formatSocketError(
  err: NodeJS.ErrnoException,
  cpId: string,
  socketPath: string,
): string {
  if (err.code === "ENOENT") {
    return `No daemon running for ${cpId} (socket not found: ${socketPath})`;
  }
  if (err.code === "ECONNREFUSED") {
    return `Daemon for ${cpId} is not accepting connections`;
  }
  return err.message;
}

export async function sendCommand(
  cpId: string,
  jsonStr: string,
): Promise<void> {
  const socketPath = getSocketPath(cpId);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    process.stderr.write("Error: --send value must be valid JSON\n");
    process.exit(1);
  }

  const line = JSON.stringify(parsed);

  return new Promise<void>((resolve, reject) => {
    const conn = net.connect(socketPath);

    conn.setTimeout(CLIENT_TIMEOUT_MS);

    let response = "";

    conn.on("connect", () => {
      conn.write(`${line}\n`);
    });

    conn.on("data", (chunk) => {
      response += chunk.toString();
    });

    conn.on("end", () => {
      const trimmed = response.trim();
      if (trimmed) {
        process.stdout.write(`${trimmed}\n`);
      }
      resolve();
    });

    conn.on("timeout", () => {
      process.stderr.write("Error: Connection timed out\n");
      conn.destroy();
      reject(new Error("Connection timed out"));
    });

    conn.on("error", (err) => {
      process.stderr.write(
        `Error: ${formatSocketError(err as NodeJS.ErrnoException, cpId, socketPath)}\n`,
      );
      reject(err);
    });
  });
}

export async function stopDaemon(cpId: string): Promise<void> {
  const socketPath = getSocketPath(cpId);
  const line = JSON.stringify({ command: "shutdown" });

  return new Promise<void>((resolve, reject) => {
    const conn = net.connect(socketPath);

    conn.setTimeout(CLIENT_TIMEOUT_MS);

    let response = "";

    conn.on("connect", () => {
      conn.write(`${line}\n`);
    });

    conn.on("data", (chunk) => {
      response += chunk.toString();
    });

    conn.on("end", () => {
      const trimmed = response.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as { ok: boolean };
          if (parsed.ok) {
            process.stdout.write(`Daemon for ${cpId} stopped.\n`);
          } else {
            process.stdout.write(`${trimmed}\n`);
          }
        } catch {
          process.stdout.write(`${trimmed}\n`);
        }
      }
      resolve();
    });

    conn.on("timeout", () => {
      process.stderr.write("Error: Connection timed out\n");
      conn.destroy();
      reject(new Error("Connection timed out"));
    });

    conn.on("error", (err) => {
      const errWithCode = err as NodeJS.ErrnoException;
      if (errWithCode.code === "ENOENT") {
        process.stderr.write(`No daemon running for ${cpId}\n`);
        resolve();
        return;
      }
      process.stderr.write(
        `Error: ${formatSocketError(errWithCode, cpId, socketPath)}\n`,
      );
      reject(err);
    });
  });
}

export async function subscribeEvents(cpId: string): Promise<void> {
  const socketPath = getSocketPath(cpId);

  return new Promise<void>((resolve, reject) => {
    const conn = net.connect(socketPath);
    let buffer = "";

    conn.on("connect", () => {
      conn.write(`${JSON.stringify({ command: "subscribe" })}\n`);
    });

    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          process.stdout.write(`${trimmed}\n`);
        }
      }
    });

    conn.on("end", () => {
      if (buffer.trim()) {
        process.stdout.write(`${buffer.trim()}\n`);
      }
      resolve();
    });

    conn.on("error", (err) => {
      process.stderr.write(
        `Error: ${formatSocketError(err as NodeJS.ErrnoException, cpId, socketPath)}\n`,
      );
      reject(err);
    });

    process.on("SIGINT", () => {
      conn.end();
    });

    process.on("SIGTERM", () => {
      conn.end();
    });
  });
}
