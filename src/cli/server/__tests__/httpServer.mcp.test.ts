/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { createHttpHandlers, MAX_MCP_REQUEST_BODY_BYTES } from "../httpServer";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createLifecycle } from "../lifecycle";
import { createRuntimeDeps } from "../socketServer";
import { createMcpHandler } from "../mcp/mcpServer";

// The fetch handler's signature wants a Bun `Server` for socket.io transport
// requests. These tests don't hit socket.io, so an opaque cast is enough.
//
const stubServer = null as any;

function basicAuthHeader(user: string, pass: string): string {
  const utf8 = unescape(encodeURIComponent(`${user}:${pass}`));
  return "Basic " + btoa(utf8);
}

describe("httpServer MCP route", () => {
  it("returns 404 when no mcp handler is configured", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const lifecycle = createLifecycle({ pidPath: null, registry });
    const handlers = createHttpHandlers({
      registry,
      bus,
      lifecycle,
      database: null,
      healthPath: "/v1/healthz",
      webConsoleBasicAuth: null,
    });

    const req = new Request("http://localhost/mcp", { method: "POST" });
    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(404);
  });

  it("returns 200 with serverInfo.name on initialize", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const lifecycle = createLifecycle({ pidPath: null, registry });

    const runtimeDeps = createRuntimeDeps({
      registry,
      bus,
      database: null,
    });
    const mcpHandler = createMcpHandler(runtimeDeps);

    const handlers = createHttpHandlers({
      registry,
      bus,
      lifecycle,
      database: null,
      healthPath: "/v1/healthz",
      webConsoleBasicAuth: null,
      mcp: { handler: mcpHandler },
    });

    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      }),
    });

    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(200);

    const text = await (res as Response).text();
    // Response should contain serverInfo with the simulator's name
    expect(text).toContain("ocpp-cp-simulator");
  });

  it("requires auth when webConsoleBasicAuth is configured", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const lifecycle = createLifecycle({ pidPath: null, registry });

    const runtimeDeps = createRuntimeDeps({
      registry,
      bus,
      database: null,
    });
    const mcpHandler = createMcpHandler(runtimeDeps);

    const handlers = createHttpHandlers({
      registry,
      bus,
      lifecycle,
      database: null,
      healthPath: "/v1/healthz",
      webConsoleBasicAuth: { username: "alice", password: "secret" },
      mcp: { handler: mcpHandler },
    });

    // Request without auth
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });

    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect((res as Response).status).toBe(401);
  });

  it("allows access with correct auth", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const lifecycle = createLifecycle({ pidPath: null, registry });

    const runtimeDeps = createRuntimeDeps({
      registry,
      bus,
      database: null,
    });
    const mcpHandler = createMcpHandler(runtimeDeps);

    const handlers = createHttpHandlers({
      registry,
      bus,
      lifecycle,
      database: null,
      healthPath: "/v1/healthz",
      webConsoleBasicAuth: { username: "alice", password: "secret" },
      mcp: { handler: mcpHandler },
    });

    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader("alice", "secret"),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      }),
    });

    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect((res as Response).status).toBe(200);
  });

  it("returns 413 when body exceeds MAX_MCP_REQUEST_BODY_BYTES", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const lifecycle = createLifecycle({ pidPath: null, registry });

    const runtimeDeps = createRuntimeDeps({
      registry,
      bus,
      database: null,
    });
    const mcpHandler = createMcpHandler(runtimeDeps);

    const handlers = createHttpHandlers({
      registry,
      bus,
      lifecycle,
      database: null,
      healthPath: "/v1/healthz",
      webConsoleBasicAuth: null,
      mcp: { handler: mcpHandler },
    });

    // Create a body larger than MAX_MCP_REQUEST_BODY_BYTES
    const largeBody = "x".repeat(MAX_MCP_REQUEST_BODY_BYTES + 1);
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(largeBody.length),
      },
      body: largeBody,
    });

    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect((res as Response).status).toBe(413);
  });

  it("returns 413 when Content-Length header exceeds MAX_MCP_REQUEST_BODY_BYTES", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const lifecycle = createLifecycle({ pidPath: null, registry });

    const runtimeDeps = createRuntimeDeps({
      registry,
      bus,
      database: null,
    });
    const mcpHandler = createMcpHandler(runtimeDeps);

    const handlers = createHttpHandlers({
      registry,
      bus,
      lifecycle,
      database: null,
      healthPath: "/v1/healthz",
      webConsoleBasicAuth: null,
      mcp: { handler: mcpHandler },
    });

    // Request with oversized Content-Length header (but small body)
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(MAX_MCP_REQUEST_BODY_BYTES + 1),
      },
      body: "{}",
    });

    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect((res as Response).status).toBe(413);
  });

  it("enforces rate limiting with injected limits", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const lifecycle = createLifecycle({ pidPath: null, registry });

    const runtimeDeps = createRuntimeDeps({
      registry,
      bus,
      database: null,
    });
    const mcpHandler = createMcpHandler(runtimeDeps);

    const handlers = createHttpHandlers({
      registry,
      bus,
      lifecycle,
      database: null,
      healthPath: "/v1/healthz",
      webConsoleBasicAuth: null,
      mcp: {
        handler: mcpHandler,
        ratePerSec: 1,
        inflightCap: 1,
      },
    });

    const makeRequest = async () => {
      const req = new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      return Promise.resolve(handlers.fetch(req, stubServer));
    };

    // First request should succeed
    const res1 = await makeRequest();
    expect((res1 as Response).status).not.toBe(429);

    // Immediately fire a second request (should hit rate limit)
    const res2 = await makeRequest();
    expect((res2 as Response).status).toBe(429);
  });

  it("returns 400 for invalid Content-Length header", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const lifecycle = createLifecycle({ pidPath: null, registry });

    const runtimeDeps = createRuntimeDeps({
      registry,
      bus,
      database: null,
    });
    const mcpHandler = createMcpHandler(runtimeDeps);

    const handlers = createHttpHandlers({
      registry,
      bus,
      lifecycle,
      database: null,
      healthPath: "/v1/healthz",
      webConsoleBasicAuth: null,
      mcp: { handler: mcpHandler },
    });

    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "not-a-number",
      },
      body: "{}",
    });

    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect((res as Response).status).toBe(400);
  });

  it("falls through to 404 for GET /mcp when no handler is configured", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const lifecycle = createLifecycle({ pidPath: null, registry });
    const handlers = createHttpHandlers({
      registry,
      bus,
      lifecycle,
      database: null,
      healthPath: "/v1/healthz",
      webConsoleBasicAuth: null,
    });

    const req = new Request("http://localhost/mcp", { method: "GET" });
    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect((res as Response).status).toBe(404);
  });

  it("answers 405 for non-POST /mcp when a handler is configured", async () => {
    const bus = new EventBus();
    const registry = new CPRegistry(bus, null);
    const lifecycle = createLifecycle({ pidPath: null, registry });
    const mcpHandler = createMcpHandler(
      createRuntimeDeps({ registry, bus, database: null }),
    );
    const handlers = createHttpHandlers({
      registry,
      bus,
      lifecycle,
      database: null,
      healthPath: "/v1/healthz",
      webConsoleBasicAuth: null,
      mcp: { handler: mcpHandler },
    });

    for (const method of ["GET", "DELETE"]) {
      const req = new Request("http://localhost/mcp", { method });
      const res = await Promise.resolve(handlers.fetch(req, stubServer));
      expect((res as Response).status).toBe(405);
      expect((res as Response).headers.get("allow")).toBe("POST");
    }
  });
});
