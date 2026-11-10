// The Node implementation of `serve()` and the Socket.IO engine (#916). Runs
// under vitest, i.e. on Node.
import { afterEach, describe, expect, it } from "vitest";
import { Server as SocketIoServer } from "socket.io";
import { io as connectClient, type Socket } from "socket.io-client";
import { serveNode } from "../node/serve";
import { createNodeSocketIoEngine } from "../node/socketIo";
import type { FetchHandler, RuntimeServer, SocketIoEngine } from "../types";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function start(
  fetch: FetchHandler,
  socketIo?: SocketIoEngine,
): Promise<{ server: RuntimeServer; base: string }> {
  const server = await serveNode({
    port: 0,
    hostname: "127.0.0.1",
    fetch,
    socketIo: socketIo ?? null,
  });
  cleanups.push(() => server.stop(true));
  return { server, base: `http://127.0.0.1:${server.port}` };
}

describe("serveNode", () => {
  it("binds port 0 to a real port and answers through the fetch handler", async () => {
    const { server, base } = await start(
      (req) =>
        new Response(`${req.method} ${new URL(req.url).pathname}`, {
          status: 201,
          headers: { "x-test": "yes" },
        }),
    );
    expect(server.port).toBeGreaterThan(0);
    const res = await fetch(`${base}/v1/healthz?x=1`);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-test")).toBe("yes");
    expect(await res.text()).toBe("GET /v1/healthz");
  });

  it("passes headers, the body and the peer address to the handler", async () => {
    let peer: string | null = null;
    const { base } = await start(async (req, server) => {
      peer = server.requestIP(req)?.address ?? null;
      return Response.json({
        auth: req.headers.get("authorization"),
        body: await req.text(),
        host: new URL(req.url).host,
      });
    });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Basic dTpw" },
      body: "x".repeat(100_000),
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.auth).toBe("Basic dTpw");
    expect(json.body).toBe("x".repeat(100_000));
    expect(json.host).toBe(new URL(base).host);
    expect(peer).toMatch(/127\.0\.0\.1$/);
  });

  it("keeps several set-cookie headers apart and answers HEAD without a body", async () => {
    const { base } = await start(() => {
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return new Response("body", { headers });
    });
    const res = await fetch(base);
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    const head = await fetch(base, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("streams a response body chunk by chunk", async () => {
    const { base } = await start(() => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("data: one\n\n"));
          await new Promise((r) => setTimeout(r, 20));
          controller.enqueue(encoder.encode("data: two\n\n"));
          controller.close();
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const res = await fetch(base);
    expect(await res.text()).toBe("data: one\n\ndata: two\n\n");
  });

  it("answers 500 when the handler throws", async () => {
    const { base } = await start(() => {
      throw new Error("boom");
    });
    const res = await fetch(base);
    expect(res.status).toBe(500);
  });

  it("rejects when the port is taken", async () => {
    const { server } = await start(() => new Response("a"));
    await expect(
      serveNode({
        port: server.port!,
        hostname: "127.0.0.1",
        fetch: () => new Response("b"),
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("stop(true) closes the listener", async () => {
    const { server, base } = await start(() => new Response("ok"));
    expect((await fetch(base)).status).toBe(200);
    server.stop(true);
    await expect(
      fetch(base, { signal: AbortSignal.timeout(2_000) }),
    ).rejects.toThrow();
  });
});

describe("Socket.IO on the Node engine", () => {
  async function startSocketIo(fetchGate?: (req: Request) => Response | null) {
    const io = new SocketIoServer({ serveClient: false });
    const engine = createNodeSocketIoEngine(io, {
      path: "/socket.io/",
      pingInterval: 25_000,
      pingTimeout: 20_000,
      maxHttpBufferSize: 1_000_000,
    });
    io.use((socket, next) => {
      const auth = socket.handshake.headers.authorization;
      if (auth === "Basic dTpw" || socket.handshake.auth?.token === "t") next();
      else next(new Error("unauthorized"));
    });
    io.on("connection", (socket) => {
      socket.on("echo", (value: unknown, ack: (v: unknown) => void) =>
        ack(value),
      );
    });
    cleanups.push(
      () => new Promise<void>((resolve) => io.close(() => resolve())),
    );
    const started = await start(async (req, server) => {
      const refused = fetchGate?.(req);
      if (refused) return refused;
      const url = new URL(req.url);
      if (url.pathname.startsWith("/socket.io/")) {
        const res = await engine.handleRequest(req, server);
        // What the HTTP handler does to every Socket.IO response.
        res.headers.set("access-control-allow-origin", "*");
        return res;
      }
      return new Response("not found", { status: 404 });
    }, engine);
    return { ...started, engine };
  }

  function connect(
    base: string,
    transports: string[],
    extra: Record<string, unknown> = {},
  ): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connectClient(base, {
        path: "/socket.io/",
        transports,
        reconnection: false,
        timeout: 5_000,
        ...extra,
      });
      cleanups.push(() => socket.close());
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", reject);
    });
  }

  it("connects over long-polling and applies the handler's headers", async () => {
    const { base } = await startSocketIo();
    const handshake = await fetch(`${base}/socket.io/?EIO=4&transport=polling`);
    expect(handshake.status).toBe(200);
    expect(handshake.headers.get("access-control-allow-origin")).toBe("*");
    expect(await handshake.text()).toMatch(/^0\{"sid":/);

    const socket = await connect(base, ["polling"], { auth: { token: "t" } });
    expect(socket.io.engine.transport.name).toBe("polling");
    await expect(socket.timeout(2_000).emitWithAck("echo", 42)).resolves.toBe(
      42,
    );
  });

  it("connects over a WebSocket upgrade with the Authorization header", async () => {
    const { base } = await startSocketIo();
    const socket = await connect(base, ["websocket"], {
      extraHeaders: { authorization: "Basic dTpw" },
    });
    expect(socket.io.engine.transport.name).toBe("websocket");
    await expect(
      socket.timeout(2_000).emitWithAck("echo", { a: 1 }),
    ).resolves.toEqual({ a: 1 });
  });

  it("refuses a handshake without credentials", async () => {
    const { base } = await startSocketIo();
    await expect(connect(base, ["websocket"])).rejects.toThrow("unauthorized");
  });

  it("lets the HTTP handler refuse an upgrade before Engine.IO sees it", async () => {
    const { base } = await startSocketIo(
      () => new Response("host not allowed", { status: 403 }),
    );
    await expect(
      connect(base, ["websocket"], {
        extraHeaders: { authorization: "Basic dTpw" },
      }),
    ).rejects.toThrow();
  });
});
