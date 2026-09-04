---
title: State persistence
type: concept
summary: Both the daemon (`bun:sqlite` via `--state-db`) and the browser (sql.js + IndexedDB) back their state with the same SQLite schema — scenarios, configuration overrides, charging profiles, availability, pending messages, CP registry and logs survive restart / reload.
sources:
  - src/ (persistence layer, CPRegistry.restoreFromDatabase)
  - docker-compose.yml (`STATE_DB`)
related:
  - ../entities/daemon.md
  - ../entities/docker-image.md
  - ../entities/web-console.md
  - log-format.md
  - network-simulation.md
  - control-plane.md
updated: 2026-09-04
---

# State persistence

The [daemon](../entities/daemon.md) keeps everything in memory by default. Pass
`--state-db <path>` to write to a SQLite file instead — useful for
survive-restart use cases (long-running CSMS integration tests, simulated EVs
that should keep their `MeterValueSampleInterval` override or their
`Inoperative` flag across reboots). The [Docker image](../entities/docker-image.md#persistent-state)
always runs with `--state-db ${STATE_DB}` (default `/data/state.db`), and the
[desktop app](../entities/desktop-app.md) writes `state.db` to the OS app-data
directory.

```bash
# Persist to a file in the current directory
ocpp-cp-sim --daemon \
            --cp-id CP001 --ws-url ws://localhost:9000/ocpp \
            --state-db ./state.db

# Inspect the DB
sqlite3 ./state.db ".tables"
# blueprints           charge_point_state   charge_points        charging_profiles
# configuration        connector_runtime    connector_settings   kv
# logs                 pending_messages     scenarios            schema_meta

# In-memory (default)
ocpp-cp-sim --daemon ...
```

## Tables

| Table                | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_meta`        | Single row stamping the schema version. Used by future migrations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scenarios`          | Scenario definitions (per CP/connector). Browser saves go through here. Template instances are idempotent per (template, connector) — see [Scenario format → Template instances](scenario-format.md#template-instances).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `connector_settings` | `auto_meter`, `availability` and `soc_meter_sync` per `(cp_id, connector_id)`. `connector_id=0` represents the CP main controller. Carries `auto_traffic` since schema v10 (#300).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `connector_runtime`  | Per-connector runtime state — status, availability, the active transaction (JSON), meter value, SoC and the last auto-started scenario / scenario position — keyed by `(cp_id, connector_id)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `charging_profiles`  | One row per active `SetChargingProfile.req`, keyed by `(cp_id, connector_id, charging_profile_id)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `configuration`      | Per-CP overrides written by `ChangeConfiguration.req` (§5.3). The OCPP defaults are computed at boot; only operator/CSMS-set values land here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pending_messages`   | Transaction-related CALLs queued while offline (§4.7 / §4.8 errata 3.18). Retried with backoff on reconnect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `logs`               | Persisted log entries — every OCPP message, scenario step, state transition. Batched writes (50 entries / 500 ms) and trimmed to 10 k rows per CP. See [Log format](log-format.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `charge_points`      | Daemon-side CP registry. Re-created on restart by `CPRegistry.restoreFromDatabase` and **auto-connected**, so the CSMS sees BootNotification fly again. Carries `supervision_urls` / `url_distribution` (v7, #296), `id_tags` / `id_tag_distribution` (v9, #299) and `id_tag_file` (v11, #314) — `ws_url` remains the single URL every other reader expects. `id_tag_file` holds the **absolute** path: `idTagPool.file` is resolved when the charge point is created, so a daemon restarted from a different working directory re-reads and re-watches the file the operator meant rather than re-resolving a relative string against the new CWD. |
| `blueprints`         | Named, reusable charge point hardware descriptions (#297), schema v8. Daemon-side only; without `--state-db` the repository keeps them in memory rather than dropping the save.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `charge_point_state` | Per-CP runtime flags (currently `desired_connected`). Browser local mode writes this on Connect/Disconnect so a reload restores the WebSocket.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `kv`                 | App-level prefs (global config, SoC↔Meter sync, [network-sim](network-simulation.md#persistence) layers under `networkSim:global` / `networkSim:cp:<cpId>`, etc.).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Reset

The browser ships a **Reset all simulator data** button (Settings page) that
calls the daemon's `state.reset` RPC in Remote mode. External clients can do the
same:

```js
await rpc({ method: "state.reset", params: {} });
```

`state.reset` truncates every simulator-owned table (schema preserved) and
disconnects / forgets every in-memory CP. Both paths drop the in-memory CPs
first so live WebSockets do not keep writing to the about-to-be-empty DB.
The MCP `call_method` tool flags `state.reset` (and `server.shutdown`) as
destructive.

## Browser

Browser mode uses the same schema, backed by sql.js + IndexedDB. Each browser
profile keeps one DB blob under the `ocpp-cp-simulator` IndexedDB database;
clearing site data wipes simulator state. sql.js is only loaded when the page
determines it is in Local mode via a `/v1/healthz` probe at the page origin
(path configurable, see [Daemon → Health](../entities/daemon.md#health)) —
Remote mode skips the WASM download entirely and uses the daemon's Socket.IO
control plane. See [Local vs Remote mode](local-vs-remote-mode.md).
