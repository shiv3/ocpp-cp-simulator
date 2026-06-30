import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  connectTestClient,
  createTestClient,
  startTestServer,
  waitForSocketEvent,
  type TestServer,
} from "./socketHarness";

const servers: TestServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("socket.io auth", () => {
  it("rejects missing handshake auth with a generic unauthorized error", async () => {
    const { server, capturedLogs, restoreLogs } =
      await authServerWithLogCapture();
    const socket = createTestClient(server);
    try {
      const [err] = await waitForSocketEvent(socket, "connect_error");

      expect(errorMessage(err)).toBe("unauthorized");
      expect(errorData(err)).toBeUndefined();
      expect(errorMessage(err)).not.toContain("operator");
      expect(errorMessage(err)).not.toContain("top-secret");
      expect(capturedLogs()).not.toContain("operator");
      expect(capturedLogs()).not.toContain("top-secret");
    } finally {
      socket.disconnect();
      restoreLogs();
    }
  });

  it("connects with correct handshake auth", async () => {
    const server = await authServer();
    const socket = await connectTestClient(server, {
      auth: { user: "operator", pass: "top-secret" },
    });
    try {
      expect(socket.connected).toBe(true);
    } finally {
      socket.disconnect();
    }
  });

  it("connects with a Basic Auth handshake header (same-origin web console replay)", async () => {
    // The bundled web console can't read the browser's cached Basic Auth
    // credentials to put them in the `auth` payload; it relies on the browser
    // replaying the `Authorization` header on the same-origin handshake. Pin
    // the polling transport so the handshake is an HTTP request that carries
    // the header.
    const server = await authServer();
    const socket = await connectTestClient(server, {
      transports: ["polling"],
      extraHeaders: {
        Authorization: basicAuthHeader("operator", "top-secret"),
      },
    });
    try {
      expect(socket.connected).toBe(true);
    } finally {
      socket.disconnect();
    }
  });

  it("rejects an incorrect Basic Auth handshake header", async () => {
    const server = await authServer();
    const socket = createTestClient(server, {
      transports: ["polling"],
      extraHeaders: { Authorization: basicAuthHeader("operator", "wrong") },
    });
    try {
      const [err] = await waitForSocketEvent(socket, "connect_error");
      expect(errorMessage(err)).toBe("unauthorized");
      expect(socket.connected).toBe(false);
    } finally {
      socket.disconnect();
    }
  });

  it("keeps static Basic Auth while leaving healthz unauthenticated", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "ocpp-cp-sim-static-"));
    tempDirs.push(staticDir);
    await writeFile(join(staticDir, "index.html"), "<!doctype html><p>ok</p>");

    const server = await authServer({ staticDir });

    const staticRes = await fetch(`${server.url}/index.html`);
    expect(staticRes.status).toBe(401);

    const healthRes = await fetch(`${server.url}/v1/healthz`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ ok: true });
  });
});

async function authServer(
  options: { staticDir?: string | null } = {},
): Promise<TestServer> {
  const server = await startTestServer({
    staticDir: options.staticDir ?? null,
    webConsoleBasicAuth: {
      username: "operator",
      password: "top-secret",
    },
  });
  servers.push(server);
  return server;
}

async function authServerWithLogCapture(): Promise<{
  server: TestServer;
  capturedLogs: () => string;
  restoreLogs: () => void;
}> {
  let captured = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = function (
    chunk: string | Uint8Array,
    ...args: unknown[]
  ): boolean {
    captured +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const arg of args) {
      if (typeof arg === "function") {
        arg();
      }
    }
    return true;
  } as typeof process.stderr.write;

  const server = await authServer();
  return {
    server,
    capturedLogs: () => captured,
    restoreLogs: () => {
      process.stderr.write = originalWrite;
    },
  };
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorData(err: unknown): unknown {
  if (!err || typeof err !== "object") return undefined;
  return (err as { data?: unknown }).data;
}
