---
title: Local vs Remote mode (browser)
type: concept
summary: The web console decides once per page load whether charge points run in-browser (Local, sql.js) or in a daemon (Remote, Socket.IO) by probing `/v1/healthz` at its own origin; there is no toggle.
sources:
  - src/ (runtime-mode detection)
  - vite.config.ts (`VITE_HEALTH_PATH`)
related:
  - ../entities/web-console.md
  - ../entities/daemon.md
  - ../entities/desktop-app.md
  - ../entities/docker-image.md
  - state-persistence.md
  - control-plane.md
updated: 2026-09-30
---

# Local vs Remote mode (browser)

The browser UI auto-detects which mode to run in by probing `/v1/healthz` at
its own origin (path configurable at build time via `VITE_HEALTH_PATH`; it
must match the daemon's `--health-path`, see [Daemon → Health](../entities/daemon.md#health)):

| Served by                                                                                                                                    | Mode       | Where charge points run     | Persistence                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------- | ------------------------------------------------- |
| `ocpp-cp-sim --web-console`, the [Docker image](../entities/docker-image.md), the [desktop app](../entities/desktop-app.md) (daemon sidecar) | **Remote** | In the daemon process       | Daemon SQLite (`--state-db`)                      |
| Static build (GitHub Pages, `bun run dev` / `npm run dev`)                                                                                   | **Local**  | Entirely in the browser tab | sql.js + IndexedDB (`ocpp-cp-simulator` database) |

- A `200` with `{ "ok": true }` → **Remote**: every operation uses the
  daemon's [Socket.IO control plane](control-plane.md) (`rpc` acks + `event`
  push). sql.js / the WASM download are skipped entirely.
- Anything else → **Local**: the sql.js engine is loaded and the same SQLite
  schema is kept in IndexedDB ([State persistence → Browser](state-persistence.md#browser)).

There is no toggle — the mode is decided once on page load and never
overridden.

## Consequences

- Feature parity differs by mode: SOAP versions are send-only in Local mode,
  security profiles 2/3 and TLS files are daemon-only
  ([OCPP versions & transports](ocpp-versions-and-transports.md),
  [Security profiles](security-profiles.md)); [network simulation](network-simulation.md)
  works in both modes from `/v3/settings`, but its RPC / MCP methods exist
  only on the daemon.
- The **Reset all simulator data** button calls `state.reset` in Remote mode
  and clears the local DB in Local mode.
- In Remote mode the browser's log download and the daemon's `logs.get` return
  the same rows ([Log format](log-format.md)).
- The scenario wait controls (extend / retry / continue, #240) work in both
  modes and refuse an idle scenario the same way. The run report that records
  them (`interventions`) and the `scenario_wait_changed` event that refreshes
  other consoles exist only on the daemon — Local mode has no run reports and
  no scenario events.
- The scenario run history (#388) is daemon-only: `scenario.runs.list`, the
  run console's recorded history and the `/v3/scenarios/runs` page need Remote
  mode. In Local mode the run console lists only the runs started or attached
  while the page is open, and forgets them when it closes.
