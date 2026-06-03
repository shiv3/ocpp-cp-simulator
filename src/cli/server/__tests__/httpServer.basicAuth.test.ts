import { describe, it, expect } from "vitest";
import { createHttpHandlers } from "../httpServer";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createLifecycle } from "../lifecycle";

// The fetch handler's signature wants a Bun `Server<SocketData>` for WS
// upgrades. Basic-auth check runs BEFORE dispatch() and the healthz route
// also doesn't touch `server`, so an opaque cast is enough for these tests.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubServer = null as any;

function makeHandlers(
  basicAuth: { username: string; password: string } | null,
): ReturnType<typeof createHttpHandlers> {
  const bus = new EventBus();
  const registry = new CPRegistry(bus, null);
  const lifecycle = createLifecycle({ pidPath: null, registry });
  return createHttpHandlers({
    registry,
    bus,
    lifecycle,
    database: null,
    healthPath: "/v1/healthz",
    webConsoleBasicAuth: basicAuth,
  });
}

function basicAuthHeader(user: string, pass: string): string {
  // UTF-8 → base64 (browser-compatible). btoa alone barfs on >0xFF code
  // points; the encodeURIComponent / unescape dance converts to UTF-8
  // bytes-as-Latin-1 first.
  const utf8 = unescape(encodeURIComponent(`${user}:${pass}`));
  return "Basic " + btoa(utf8);
}

describe("httpServer Basic Auth gate", () => {
  it("passes through when webConsoleBasicAuth is null", async () => {
    const handlers = makeHandlers(null);
    const req = new Request("http://localhost/v1/healthz");
    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(200);
  });

  it("returns 401 + WWW-Authenticate when header is missing", async () => {
    const handlers = makeHandlers({ username: "alice", password: "secret" });
    const req = new Request("http://localhost/v1/cps");
    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
    // realm in WWW-Authenticate is what makes browsers show a creds prompt.
    expect((res as Response).headers.get("www-authenticate")).toMatch(
      /^Basic realm=/,
    );
  });

  it("returns 401 for the wrong password", async () => {
    const handlers = makeHandlers({ username: "alice", password: "secret" });
    const req = new Request("http://localhost/v1/cps", {
      headers: { authorization: basicAuthHeader("alice", "wrong") },
    });
    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect((res as Response).status).toBe(401);
  });

  it("returns 401 for the wrong username", async () => {
    const handlers = makeHandlers({ username: "alice", password: "secret" });
    const req = new Request("http://localhost/v1/cps", {
      headers: { authorization: basicAuthHeader("bob", "secret") },
    });
    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect((res as Response).status).toBe(401);
  });

  it("returns 401 on garbled / non-Basic Authorization header", async () => {
    const handlers = makeHandlers({ username: "alice", password: "secret" });
    const req = new Request("http://localhost/v1/cps", {
      headers: { authorization: "Bearer xyz" },
    });
    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect((res as Response).status).toBe(401);
  });

  it("passes through with correct credentials", async () => {
    const handlers = makeHandlers({ username: "alice", password: "secret" });
    const req = new Request("http://localhost/v1/healthz", {
      headers: { authorization: basicAuthHeader("alice", "secret") },
    });
    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect((res as Response).status).toBe(200);
  });

  it("exempts the configured health path from auth (no header needed)", async () => {
    const handlers = makeHandlers({ username: "alice", password: "secret" });
    const req = new Request("http://localhost/v1/healthz");
    const res = await Promise.resolve(handlers.fetch(req, stubServer));
    expect((res as Response).status).toBe(200);
  });

  it("supports non-ASCII credentials via UTF-8 base64", async () => {
    // OCPP CSMS deployments occasionally hand operators non-ASCII passwords
    // (Japanese / German). atob in Bun handles the bytes directly, so this
    // case must work the same as ASCII.
    const handlers = makeHandlers({
      username: "operator",
      password: "パスワード",
    });
    const goodReq = new Request("http://localhost/v1/cps", {
      headers: { authorization: basicAuthHeader("operator", "パスワード") },
    });
    const badReq = new Request("http://localhost/v1/cps", {
      headers: { authorization: basicAuthHeader("operator", "ぱすわーど") },
    });

    const goodRes = await Promise.resolve(handlers.fetch(goodReq, stubServer));
    // After auth passes the request falls through to dispatch which hits
    // a no-such-route case and returns 404 — that's fine, we only care
    // that the gate let it through.
    expect((goodRes as Response).status).not.toBe(401);

    const badRes = await Promise.resolve(handlers.fetch(badReq, stubServer));
    expect((badRes as Response).status).toBe(401);
  });
});
