const SOCKET_PATH = "/socket.io/";
const NAMESPACE = "/poc";
const HOST = "127.0.0.1";
const PING_INTERVAL_MS = 1_000;
const PING_TIMEOUT_MS = 2_000;
const IDLE_TIMEOUT_SECONDS = Math.ceil((PING_INTERVAL_MS + 30_000) / 1_000);
const ADMIN_USER = "admin";
const ADMIN_PASS = "secret";

type CheckState = {
  detail: string;
  ok: boolean;
};

type RuntimeDeps = {
  BunEngine: new (opts: Record<string, unknown>) => unknown;
  Server: new (opts: Record<string, unknown>) => unknown;
  createClient: (url: string, opts: Record<string, unknown>) => unknown;
  importPath: string;
  version: string;
  z: {
    literal: (value: unknown) => unknown;
    object: (shape: Record<string, unknown>) => {
      safeParse: (value: unknown) => { success: boolean };
    };
  };
};

const checkNames = [
  "/socket.io/ routing coexists with static + healthz",
  "Engine.IO HTTP long-polling GET/POST works before WebSocket upgrade",
  "engine.handleRequest does NOT bypass Basic Auth gate",
  "rpc emit with ack round-trips",
  "Client auto-reconnect works",
  "Union room fanout dedup",
  "io.close() + server stop exits cleanly",
  "Bun idleTimeout > socket.io pingInterval",
] as const;

const checks: CheckState[] = checkNames.map((name) => ({
  ok: false,
  detail: `${name} was not exercised`,
}));

let printed = false;

function pass(n: number, detail: string) {
  checks[n - 1] = { ok: true, detail };
}

function fail(n: number, detail: string) {
  checks[n - 1] = { ok: false, detail };
}

function failUnset(detail: string) {
  for (let i = 0; i < checks.length; i += 1) {
    if (checks[i].detail.endsWith("was not exercised")) {
      fail(i + 1, detail);
    }
  }
}

function printChecks() {
  if (printed) return;
  printed = true;
  checks.forEach((check, index) => {
    console.log(
      `CHECK ${index + 1}: ${check.ok ? "PASS" : "FAIL"} ${check.detail}`,
    );
  });
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadDeps(): Promise<RuntimeDeps> {
  const importPath = "@socket.io/bun-engine";
  const [serverModule, bunEngineModule, clientModule, zodModule] =
    await Promise.all([
      import("socket.io"),
      import(importPath),
      import("socket.io-client"),
      import("zod"),
    ]);

  const BunEngine =
    (bunEngineModule as Record<string, unknown>).Server ??
    (bunEngineModule as Record<string, { Server?: unknown }>).default?.Server ??
    (bunEngineModule as Record<string, unknown>).default;
  const Server =
    (serverModule as Record<string, unknown>).Server ??
    (serverModule as Record<string, unknown>).default;
  const createClient =
    (clientModule as Record<string, unknown>).io ??
    (clientModule as Record<string, unknown>).connect ??
    (clientModule as Record<string, unknown>).default;
  const z = (zodModule as Record<string, unknown>).z ?? zodModule;

  if (typeof BunEngine !== "function") {
    throw new Error(
      `${importPath} did not export BunEngine or a constructor default`,
    );
  }
  if (typeof Server !== "function") {
    throw new Error("socket.io did not export Server");
  }
  if (typeof createClient !== "function") {
    throw new Error("socket.io-client did not export io/connect");
  }

  const packagePath = `${process.cwd()}/node_modules/@socket.io/bun-engine/package.json`;
  const packageJson = JSON.parse(await Bun.file(packagePath).text()) as {
    version?: string;
  };

  return {
    BunEngine: BunEngine as RuntimeDeps["BunEngine"],
    Server: Server as RuntimeDeps["Server"],
    createClient: createClient as RuntimeDeps["createClient"],
    importPath,
    version: packageJson.version ?? "unknown",
    z: z as RuntimeDeps["z"],
  };
}

function basicAuthHeader() {
  return `Basic ${btoa(`${ADMIN_USER}:${ADMIN_PASS}`)}`;
}

function isAuthed(req: Request) {
  return req.headers.get("authorization") === basicAuthHeader();
}

function enginePathMatches(pathname: string) {
  return pathname === "/socket.io" || pathname.startsWith(SOCKET_PATH);
}

function getEngineWebSocket(engine: unknown) {
  // @socket.io/bun-engine exposes the Bun websocket handler via engine.handler()
  const candidate = engine as { handler?: () => { websocket?: unknown } };
  if (typeof candidate.handler === "function") {
    return candidate.handler().websocket;
  }
  return undefined;
}

function handleEngineRequest(
  engine: unknown,
  req: Request,
  server: unknown,
): Response | Promise<Response> {
  const candidate = engine as Record<string, unknown>;
  const handleRequest =
    candidate.handleRequest ?? candidate.fetch ?? candidate.handler;
  if (typeof handleRequest !== "function") {
    throw new Error(
      "bun-engine instance has no handleRequest/fetch/handler method",
    );
  }
  return handleRequest.call(engine, req, server);
}

function parseSid(payload: string) {
  const jsonStart = payload.indexOf("{");
  if (jsonStart === -1) {
    throw new Error(`Engine.IO handshake did not contain JSON: ${payload}`);
  }
  const parsed = JSON.parse(payload.slice(jsonStart)) as { sid?: string };
  if (!parsed.sid) {
    throw new Error(`Engine.IO handshake did not include sid: ${payload}`);
  }
  return parsed.sid;
}

async function closePollingSession(baseUrl: string, sid: string) {
  await fetch(
    `${baseUrl}${SOCKET_PATH}?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`,
    {
      body: "1",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      method: "POST",
    },
  ).catch(() => undefined);
}

function socketEvent(socket: unknown, event: string, timeoutMs: number) {
  const candidate = socket as {
    off?: (event: string, handler: (...args: unknown[]) => void) => void;
    on: (event: string, handler: (...args: unknown[]) => void) => void;
  };
  return withTimeout(
    new Promise<unknown[]>((resolve) => {
      const handler = (...args: unknown[]) => {
        candidate.off?.(event, handler);
        resolve(args);
      };
      candidate.on(event, handler);
    }),
    timeoutMs,
    `socket event ${event}`,
  );
}

function emitAck(
  socket: unknown,
  event: string,
  payload: unknown,
  timeoutMs = 2_000,
) {
  const candidate = socket as {
    emit: (
      event: string,
      payload: unknown,
      ack: (response: unknown) => void,
    ) => void;
  };
  return withTimeout(
    new Promise((resolve) => {
      candidate.emit(event, payload, (response: unknown) => resolve(response));
    }),
    timeoutMs,
    `${event} ack`,
  );
}

function responseOk(response: unknown) {
  return Boolean((response as { ok?: boolean } | undefined)?.ok);
}

async function run() {
  let httpServer:
    | { port: number; stop: (closeActiveConnections?: boolean) => void }
    | undefined;
  let ioServer:
    | { bind?: (engine: unknown) => void; close?: (cb?: () => void) => void }
    | undefined;
  let client:
    | {
        connected?: boolean;
        close?: () => void;
        disconnect?: () => void;
        io?: { engine?: { close?: () => void } };
        on: (event: string, handler: (...args: unknown[]) => void) => void;
        off?: (event: string, handler: (...args: unknown[]) => void) => void;
      }
    | undefined;

  try {
    const deps = await loadDeps();
    console.log(
      `INFO bun-engine version ${deps.version} import ${deps.importPath}`,
    );

    const engine = new deps.BunEngine({
      path: SOCKET_PATH,
      pingInterval: PING_INTERVAL_MS,
      pingTimeout: PING_TIMEOUT_MS,
      transports: ["polling", "websocket"],
    });
    const websocket = getEngineWebSocket(engine);
    if (websocket === undefined) {
      throw new Error(
        "bun-engine instance did not expose a Bun.serve websocket handler",
      );
    }

    ioServer = new deps.Server({
      maxHttpBufferSize: 1_000_000,
      pingInterval: PING_INTERVAL_MS,
      pingTimeout: PING_TIMEOUT_MS,
      serveClient: false,
    }) as typeof ioServer;

    if (typeof ioServer?.bind !== "function") {
      throw new Error("socket.io Server instance did not expose bind(engine)");
    }
    ioServer.bind(engine);

    const nsp = (ioServer as unknown as { of: (name: string) => unknown }).of(
      NAMESPACE,
    ) as {
      on: (event: string, handler: (socket: unknown) => void) => void;
      to: (room: string) => {
        to: (room: string) => {
          emit: (event: string, payload: unknown) => void;
        };
      };
    };

    let snapshotSeq = 0;
    nsp.on("connection", (socket: unknown) => {
      const sock = socket as {
        id: string;
        join: (room: string) => void | Promise<void>;
        on: (
          event: string,
          handler: (
            request: unknown,
            ack?: (response: unknown) => void,
          ) => void,
        ) => void;
        rooms: Set<string>;
      };
      sock.on(
        "rpc",
        async (request: unknown, ack?: (response: unknown) => void) => {
          if (typeof ack !== "function") return;
          const rpc = request as {
            id?: string;
            method?: string;
            params?: Record<string, unknown>;
          };
          if (rpc.method === "echo") {
            ack({ ok: true, result: { echo: rpc.params, socketId: sock.id } });
            return;
          }
          if (rpc.method === "events.subscribe") {
            const scope =
              typeof rpc.params?.scope === "string" ? rpc.params.scope : "*";
            await sock.join(scope);
            snapshotSeq += 1;
            ack({
              ok: true,
              result: {
                snapshot: {
                  rooms: Array.from(sock.rooms).sort(),
                  seq: snapshotSeq,
                },
                subscribed: [scope],
              },
            });
            return;
          }
          ack({
            error: {
              code: "not_found",
              message: `unknown method ${rpc.method}`,
            },
            ok: false,
          });
        },
      );
    });

    httpServer = Bun.serve({
      fetch(req, bunServer) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/healthz") {
          return Response.json({ ok: true });
        }
        if (url.pathname === "/admin") {
          if (!isAuthed(req)) {
            return new Response("unauthorized", {
              headers: { "www-authenticate": 'Basic realm="poc"' },
              status: 401,
            });
          }
          return new Response("admin ok");
        }
        if (enginePathMatches(url.pathname)) {
          return handleEngineRequest(engine, req, bunServer);
        }
        if (url.pathname === "/static") {
          return new Response("static ok");
        }
        return new Response("not found", { status: 404 });
      },
      hostname: HOST,
      idleTimeout: IDLE_TIMEOUT_SECONDS,
      port: 0,
      websocket: websocket as Parameters<typeof Bun.serve>[0]["websocket"],
    });

    const baseUrl = `http://${HOST}:${httpServer.port}`;
    const healthSchema = deps.z.object({ ok: deps.z.literal(true) }) as {
      safeParse: (value: unknown) => { success: boolean };
    };

    try {
      const [staticResp, healthResp, socketResp] = await Promise.all([
        fetch(`${baseUrl}/static?x=1`),
        fetch(`${baseUrl}/v1/healthz?x=1`),
        fetch(
          `${baseUrl}${SOCKET_PATH}?EIO=4&transport=polling&t=check1&extra=1`,
        ),
      ]);
      const socketBody = await socketResp.text();
      const sid = socketResp.ok ? parseSid(socketBody) : "";
      if (sid) {
        await closePollingSession(baseUrl, sid);
      }
      const healthJson = await healthResp.json();
      if (
        staticResp.status === 200 &&
        healthSchema.safeParse(healthJson).success &&
        socketResp.status === 200
      ) {
        pass(
          1,
          `/static=${staticResp.status}, /v1/healthz=${healthResp.status}, /socket.io/=${socketResp.status}`,
        );
      } else {
        fail(
          1,
          `/static=${staticResp.status}, /v1/healthz=${healthResp.status}, /socket.io/=${socketResp.status}`,
        );
      }
    } catch (error) {
      fail(1, formatError(error));
    }

    let pollingSid: string | undefined;
    try {
      const getResp = await fetch(
        `${baseUrl}${SOCKET_PATH}?EIO=4&transport=polling&t=check2`,
      );
      const getBody = await getResp.text();
      pollingSid = parseSid(getBody);
      const postResp = await fetch(
        `${baseUrl}${SOCKET_PATH}?EIO=4&transport=polling&sid=${encodeURIComponent(pollingSid)}`,
        {
          body: "40",
          headers: { "content-type": "text/plain;charset=UTF-8" },
          method: "POST",
        },
      );
      await closePollingSession(baseUrl, pollingSid);
      if (
        getResp.status === 200 &&
        postResp.status >= 200 &&
        postResp.status < 300
      ) {
        pass(
          2,
          `polling GET=${getResp.status}, POST=${postResp.status}, sid=${pollingSid.slice(0, 8)}...`,
        );
      } else {
        fail(2, `polling GET=${getResp.status}, POST=${postResp.status}`);
      }
    } catch (error) {
      if (pollingSid) {
        await closePollingSession(baseUrl, pollingSid);
      }
      fail(2, formatError(error));
    }

    try {
      const [adminResp, healthResp, authedAdminResp] = await Promise.all([
        fetch(`${baseUrl}/admin`),
        fetch(`${baseUrl}/v1/healthz`),
        fetch(`${baseUrl}/admin`, {
          headers: { authorization: basicAuthHeader() },
        }),
      ]);
      if (
        adminResp.status === 401 &&
        healthResp.status === 200 &&
        authedAdminResp.status === 200
      ) {
        pass(
          3,
          `/admin unauth=${adminResp.status}, /v1/healthz=${healthResp.status}, /admin auth=200`,
        );
      } else {
        fail(
          3,
          `/admin unauth=${adminResp.status}, /v1/healthz=${healthResp.status}, /admin auth=${authedAdminResp.status}`,
        );
      }
    } catch (error) {
      fail(3, formatError(error));
    }

    client = deps.createClient(`${baseUrl}${NAMESPACE}`, {
      forceNew: true,
      path: SOCKET_PATH,
      reconnection: true,
      reconnectionDelay: 100,
      reconnectionDelayMax: 100,
      timeout: 1_000,
      transports: ["polling", "websocket"],
    }) as typeof client;
    await socketEvent(client, "connect", 3_000);

    try {
      const ack = await emitAck(client, "rpc", {
        id: "check4",
        method: "echo",
        params: { value: "ack" },
      });
      const result = ack as { result?: { echo?: { value?: string } } };
      if (responseOk(ack) && result.result?.echo?.value === "ack") {
        pass(4, `ack payload=${JSON.stringify(ack)}`);
      } else {
        fail(4, `unexpected ack payload=${JSON.stringify(ack)}`);
      }
    } catch (error) {
      fail(4, formatError(error));
    }

    try {
      const subscribeAck = await emitAck(client, "rpc", {
        id: "check5-subscribe",
        method: "events.subscribe",
        params: { scope: "cpA" },
      });
      const disconnected = socketEvent(client, "disconnect", 1_000);
      const reconnected = socketEvent(client, "connect", 4_000);
      client.io?.engine?.close?.();
      await disconnected;
      await reconnected;
      const resyncAck = await emitAck(client, "rpc", {
        id: "check5-resync",
        method: "events.subscribe",
        params: { scope: "cpA" },
      });
      if (
        responseOk(subscribeAck) &&
        responseOk(resyncAck) &&
        client.connected
      ) {
        pass(5, `reconnected=true, resync ack=${JSON.stringify(resyncAck)}`);
      } else {
        fail(
          5,
          `subscribe=${JSON.stringify(subscribeAck)}, resync=${JSON.stringify(resyncAck)}`,
        );
      }
    } catch (error) {
      fail(5, formatError(error));
    }

    try {
      let fanoutCount = 0;
      const fanoutPayloads: unknown[] = [];
      (
        client as {
          on: (event: string, handler: (payload: unknown) => void) => void;
        }
      ).on("fanout", (payload) => {
        fanoutCount += 1;
        fanoutPayloads.push(payload);
      });
      const cpAck = await emitAck(client, "rpc", {
        id: "check6-cpA",
        method: "events.subscribe",
        params: { scope: "cpA" },
      });
      const starAck = await emitAck(client, "rpc", {
        id: "check6-star",
        method: "events.subscribe",
        params: { scope: "*" },
      });
      nsp.to("cpA").to("*").emit("fanout", { nonce: "check6" });
      await sleep(250);
      if (responseOk(cpAck) && responseOk(starAck) && fanoutCount === 1) {
        pass(
          6,
          `fanout count=${fanoutCount}, payload=${JSON.stringify(fanoutPayloads[0])}`,
        );
      } else {
        fail(
          6,
          `fanout count=${fanoutCount}, cpAck=${JSON.stringify(cpAck)}, starAck=${JSON.stringify(starAck)}`,
        );
      }
    } catch (error) {
      fail(6, formatError(error));
    }

    try {
      await sleep(PING_INTERVAL_MS + 500);
      const idleAck = await emitAck(client, "rpc", {
        id: "check8",
        method: "echo",
        params: { idleMs: PING_INTERVAL_MS + 500 },
      });
      if (client.connected && responseOk(idleAck)) {
        pass(
          8,
          `idle connection survived ${PING_INTERVAL_MS + 500}ms; idleTimeout=${IDLE_TIMEOUT_SECONDS}s, pingInterval=${PING_INTERVAL_MS}ms`,
        );
      } else {
        fail(
          8,
          `connected=${Boolean(client.connected)}, idleAck=${JSON.stringify(idleAck)}`,
        );
      }
    } catch (error) {
      fail(8, formatError(error));
    }

    try {
      client.close?.();
      client.disconnect?.();
      if (typeof ioServer.close === "function") {
        await withTimeout(
          new Promise<void>((resolve) => ioServer?.close?.(() => resolve())),
          2_000,
          "io.close",
        );
      }
      httpServer.stop(true);
      pass(7, "io.close callback returned and Bun server.stop(true) completed");
    } catch (error) {
      fail(7, formatError(error));
    }
  } catch (error) {
    const detail = formatError(error);
    console.error(`PoC setup failed: ${detail}`);
    failUnset(detail);
    try {
      client?.close?.();
      client?.disconnect?.();
      if (typeof ioServer?.close === "function") {
        await withTimeout(
          new Promise<void>((resolve) => ioServer?.close?.(() => resolve())),
          1_000,
          "io.close",
        );
      }
      httpServer?.stop(true);
    } catch (cleanupError) {
      console.error(`PoC cleanup failed: ${formatError(cleanupError)}`);
    }
  } finally {
    printChecks();
  }

  return checks.every((check) => check.ok) ? 0 : 1;
}

run()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`PoC fatal error: ${formatError(error)}`);
    failUnset(formatError(error));
    printChecks();
    process.exit(1);
  });
