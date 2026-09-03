---
title: "Source: scripts/poc/README.md (socket.io on Bun.serve PoC)"
type: source
summary: The Task-0 gate that decided the control plane could be socket.io on `Bun.serve` + `@socket.io/bun-engine` — 8 acceptance checks, all PASS — plus wiring notes used by the implementation.
sources:
  - scripts/poc/README.md
  - scripts/poc/socketio-bun-poc.ts
related:
  - ../concepts/control-plane.md
  - ../analyses/rest-to-socketio-migration.md
  - ../concepts/access-control.md
updated: 2026-09-03
---

# Source: `scripts/poc/README.md`

**Verdict: PASS — proceed with socket.io.** Run with
`bun scripts/poc/socketio-bun-poc.ts`.

**Checks that passed** (production server shape: `Bun.serve` +
`@socket.io/bun-engine`):

1. `/socket.io/` routing coexists with static + healthz (query + trailing slash)
2. Engine.IO HTTP long-polling GET/POST works before WebSocket upgrade
3. Basic Auth gate is **not** bypassed by the engine (`/admin` unauth = 401, `/v1/healthz` exempt = 200)
4. `rpc` emit with ack round-trips
5. client auto-reconnect + resync
6. union room fan-out dedup (`io.to(cpA).to("*").emit` → received exactly once)
7. `io.close()` + `Bun.server.stop(true)` exits cleanly
8. Bun `idleTimeout` (31 s) > socket.io `pingInterval`; idle connection survives

**Implementation notes carried into the daemon.**

- Versions at the time: `@socket.io/bun-engine@0.1.1`, `socket.io@4.8.3`,
  `socket.io-client@4.8.3`, `zod@4.4.3` (protocol module targets the zod v4 API).
- Wiring: `new Server({ serveClient: false })` bound to a bun-engine `Engine`
  (`path: "/socket.io/"`, `pingInterval`, `pingTimeout`,
  `maxHttpBufferSize: 1_000_000`); `Bun.serve` handles own routes (static /
  healthz / Basic Auth) first and delegates `/socket.io/…` to
  `engine.handleRequest(req, server)`; `idleTimeout` **must** exceed
  `pingInterval`.
- Handshake auth can use the engine's `allowRequest` hook or `io.use`; Basic
  Auth on static/non-health routes stays in the `fetch` handler.

These decisions are visible today as the [control plane](../concepts/control-plane.md)
and the [access-control](../concepts/access-control.md) rules.
