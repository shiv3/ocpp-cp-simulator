import { createServer, type Server as HttpServer } from "node:http";
import { describe, it, expect } from "vitest";
import { Server as SocketIoServer, type Socket } from "socket.io";

import { sendCommand, stopDaemon } from "../client";

interface CaptureServer {
  url: string;
  close: () => Promise<void>;
  lastAuth: () => unknown;
  lastRpc: () => unknown;
}

function startCaptureServer(): Promise<CaptureServer> {
  let lastAuth: unknown;
  let lastRpc: unknown;
  const httpServer = createServer();
  const io = new SocketIoServer(httpServer, {
    path: "/socket.io/",
    serveClient: false,
  });

  io.on("connection", (socket: Socket) => {
    lastAuth = socket.handshake.auth;
    socket.on("rpc", (request: unknown, ack: (response: unknown) => void) => {
      lastRpc = request;
      ack({ ok: true, result: { accepted: true } });
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => closeServers(io, httpServer),
        lastAuth: () => lastAuth,
        lastRpc: () => lastRpc,
      });
    });
  });
}

function closeServers(
  io: SocketIoServer,
  httpServer: HttpServer,
): Promise<void> {
  return new Promise((resolve) => {
    io.close(() => {
      httpServer.close(() => resolve());
    });
  });
}

async function captureOutput(run: () => Promise<void>): Promise<{
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  process.stdout.write = function (
    chunk: string | Uint8Array,
    ...args: unknown[]
  ): boolean {
    stdout +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    callWriteCallback(args);
    return true;
  } as typeof process.stdout.write;

  process.stderr.write = function (
    chunk: string | Uint8Array,
    ...args: unknown[]
  ): boolean {
    stderr +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    callWriteCallback(args);
    return true;
  } as typeof process.stderr.write;

  try {
    await run();
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  return { stdout, stderr };
}

function callWriteCallback(args: unknown[]): void {
  for (const arg of args) {
    if (typeof arg === "function") {
      arg();
    }
  }
}

describe("CLI socket.io client", () => {
  it("sends handshake auth and rpc payloads for --send", async () => {
    const srv = await startCaptureServer();
    try {
      const output = await captureOutput(() =>
        sendCommand(
          {
            httpUrl: srv.url,
            basicAuth: { username: "admin", password: "secret" },
          },
          "CP001",
          JSON.stringify({
            id: "cmd-1",
            command: "status",
            params: {},
          }),
        ),
      );

      expect(output.stderr).toBe("");
      expect(output.stdout).toBe(
        '{"id":"cmd-1","ok":true,"data":{"accepted":true}}\n',
      );
      expect(srv.lastAuth()).toEqual({
        username: "admin",
        password: "secret",
      });
      expect(srv.lastRpc()).toEqual({
        cpId: "CP001",
        method: "status",
        params: {},
      });
    } finally {
      await srv.close();
    }
  });

  it("omits handshake auth when no credentials are provided", async () => {
    const srv = await startCaptureServer();
    try {
      await captureOutput(() =>
        sendCommand(
          { httpUrl: srv.url },
          "CP001",
          JSON.stringify({ command: "status" }),
        ),
      );

      expect(srv.lastAuth()).toEqual({});
    } finally {
      await srv.close();
    }
  });

  it("uses rpc server.shutdown for --stop", async () => {
    const srv = await startCaptureServer();
    try {
      const output = await captureOutput(() =>
        stopDaemon({
          httpUrl: srv.url,
          basicAuth: { username: "ops", password: "p@ss" },
        }),
      );

      expect(output.stdout).toBe("Server stopped.\n");
      expect(output.stderr).toBe("");
      expect(srv.lastAuth()).toEqual({
        username: "ops",
        password: "p@ss",
      });
      expect(srv.lastRpc()).toEqual({
        method: "server.shutdown",
        params: {},
      });
    } finally {
      await srv.close();
    }
  });

  it("passes non-ASCII credentials through socket handshake auth", async () => {
    const srv = await startCaptureServer();
    try {
      await captureOutput(() =>
        sendCommand(
          {
            httpUrl: srv.url,
            basicAuth: { username: "operator", password: "パスワード" },
          },
          "CP001",
          JSON.stringify({ command: "status" }),
        ),
      );

      expect(srv.lastAuth()).toEqual({
        username: "operator",
        password: "パスワード",
      });
    } finally {
      await srv.close();
    }
  });
});
