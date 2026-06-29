# PoC — socket.io on `Bun.serve` (Task 0 gate)

**Verdict: PASS — proceed with socket.io.** All 8 acceptance checks pass on the production server shape (`Bun.serve` + `@socket.io/bun-engine`). No fallback to native WS needed.

Run: `bun scripts/poc/socketio-bun-poc.ts`

```
INFO bun-engine version 0.1.1 import @socket.io/bun-engine
CHECK 1: PASS  /socket.io/ routing coexists with static + healthz (query + trailing slash)
CHECK 2: PASS  Engine.IO HTTP long-polling GET/POST works before WebSocket upgrade
CHECK 3: PASS  Basic Auth gate NOT bypassed by the engine (/admin unauth=401, /v1/healthz exempt=200)
CHECK 4: PASS  rpc emit with ack round-trips
CHECK 5: PASS  client auto-reconnect + resync
CHECK 6: PASS  union room fanout dedup (io.to(cpA).to("*").emit → received exactly once)
CHECK 7: PASS  io.close() + Bun server.stop(true) exits cleanly
CHECK 8: PASS  Bun idleTimeout (31s) > socket.io pingInterval (1000ms); idle connection survives
```

## API notes for the implementation (Tasks 4 / 8)

- Versions: `@socket.io/bun-engine@0.1.1`, `socket.io@4.8.3`, `socket.io-client@4.8.3`, `zod@4.4.3`.
- Wiring:
  ```ts
  import { Server as Engine } from "@socket.io/bun-engine";
  import { Server } from "socket.io";
  const io = new Server({ serveClient: false });
  const engine = new Engine({
    path: "/socket.io/",
    pingInterval,
    pingTimeout,
    maxHttpBufferSize: 1_000_000,
  });
  io.bind(engine);
  const { websocket } = engine.handler();
  Bun.serve({
    idleTimeout, // MUST be > pingInterval (Check 8)
    fetch(req, server) {
      // own routes (static / healthz / Basic Auth) first;
      // for "/socket.io/..." delegate: return engine.handleRequest(req, server);
    },
    websocket, // from engine.handler()
  });
  ```
- The engine exposes `handleRequest(req, server): Promise<Response>` (call it for `/socket.io/` paths) and `handler()` → `{ fetch, websocket, idleTimeout, maxRequestBodySize }`.
- **Auth hook:** the engine constructor takes `allowRequest?: (req, server) => Promise<void>` and `cors`. Handshake auth (Task 8) can use `allowRequest` (throw/reject to deny) or socket.io `io.use`. Confirm which surfaces a clean `connect_error` without leaking credentials.
- Basic Auth on static/non-health routes stays in the Bun.serve `fetch` (verified it is NOT bypassed by the engine).

## Notes

- zod resolved to v4.x (`zod@4.4.3`) — the protocol module should target the zod v4 API.
- Sandbox: the Codex sandbox blocks outbound network, so `bun add` was run in the main session. `bun.lock` verified clean of any private CodeArtifact URL; the four packages resolve from `registry.npmjs.org`.
- PoC script fixes vs. the first draft: `@socket.io/bun-engine` exports `Server` (not `BunEngine`); the Bun websocket handler comes from `engine.handler().websocket`.
