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
updated: 2026-10-02
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
  works in both modes from `/settings`, but its RPC / MCP methods exist
  only on the daemon.
- The **Reset all simulator data** button calls `state.reset` in Remote mode
  and clears the local DB in Local mode.
- In Remote mode the browser's log download and the daemon's `logs.get` return
  the same rows ([Log format](log-format.md)).
- [Expert OCPP calls](expert-ocpp-calls.md) (#389) work in both modes: the
  console's Expert tab calls the in-tab charge point in Local mode and
  `send_ocpp_call` on the daemon in Remote mode, which is also the method the
  MCP tool and JSON-Lines mode use.
- Scenarios run in both modes without depending on which page is open. In
  Local mode each charge point's scenario runtime (`LocalScenarioRuntime`,
  owned by the browser's data layer) loads the connector's saved scenarios,
  fires status triggers and the connect / status auto-start, and reports runs
  as `scenario-started` / `-node-execute` / `-completed` / `-error` /
  `-wait-changed` events — the same events the daemon pushes, without a
  `runId`. Before #411 that runtime lived in the classic UI's connector card:
  with only the web console open, a Local-mode scenario could not run.
  Auto-start follows the daemon's rules
  ([Scenario format → start notes](scenario-format.md#start-notes-triggeron-connect-fires-on-_every_-connect)).
- The scenario wait controls (extend / retry / continue, #240) work in both
  modes and refuse an idle scenario the same way. The run report that records
  them (`interventions`) exists only on the daemon — Local mode has no run
  reports.
- The scenario run history (#388) is daemon-only: `scenario.runs.list`, the
  run console's recorded history and the `/scenarios/runs` page need Remote
  mode. In Local mode the run console lists only the runs started or attached
  while the page is open, and forgets them when it closes. This is a deferred
  part of #388, not a design choice: the browser runtime builds no run
  reports (the transcript capture, assertion evaluation and verdict live in
  the daemon's service), so it has nothing to record. Moving that report
  builder to the shared application layer and recording local runs in the
  sql.js `scenario_runs` table is tracked in #394.
