# Docker

The image bundles **both** the daemon and the React browser UI in a single Bun-based container. `--web-console` is enabled by default, so opening the published port in a browser gives you the full UI talking to the API on the same origin.

Hosted images live at **`ghcr.io/shiv3/ocpp-cp-simulator`** (built by [`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml) on push to `main` and on `v*` / `cli-v*` tags).

### Image tags

| Tag                      | Moves?    | Use it for                                                       |
| ------------------------ | --------- | ---------------------------------------------------------------- |
| `latest`                 | mutable   | Bleeding edge — tracks the newest `main` build.                  |
| `main`                   | mutable   | Same as `latest`; explicit about the source branch.              |
| `sha-<short>`            | immutable | Pin to one exact `main` commit.                                  |
| `X.Y.Z` (e.g. `1.2.3`)   | immutable | **Reproducible release pin** — recommended for IaC / production. |
| `X.Y` (e.g. `1.2`) / `X` | mutable   | Auto-track patch / minor releases within a version line.         |

Semver tags are published when a `vX.Y.Z` git tag is pushed (the same tag that cuts the desktop-app [release](../.github/workflows/release.yml)). For production, pin to a full `X.Y.Z` (or a digest) rather than `latest`/`main`:

```sh
docker pull ghcr.io/shiv3/ocpp-cp-simulator:1.2.3
```

## Quick start

```sh
# Pull the latest published image
docker pull ghcr.io/shiv3/ocpp-cp-simulator:latest

# Run with an ephemeral state DB (state wiped on container exit)
docker run --rm -p 9700:9700 \
  -e STATE_DB=:memory: \
  ghcr.io/shiv3/ocpp-cp-simulator:latest \
  --cp-id CP001 --connectors 2 \
  --ws-url wss://example.invalid/chargepoint/

# Open the bundled UI
open http://localhost:9700/
```

## Persistent state

The image declares `/data` as a managed volume and the entrypoint bakes in `--state-db ${STATE_DB}` (default `/data/state.db`). To survive container restart/recreate, mount a host directory or named volume there:

```sh
# Host bind mount — easy to inspect with sqlite3
mkdir -p ./.state
docker run --rm -p 9700:9700 \
  -v "$PWD/.state:/data" \
  ghcr.io/shiv3/ocpp-cp-simulator:latest \
  --cp-id CP001 --connectors 2 \
  --ws-url wss://example.invalid/chargepoint/

# Inspect the persisted state
sqlite3 ./.state/state.db ".tables"
# charge_point_state  charging_profiles   connector_settings  kv
# charge_points       configuration       logs                pending_messages
# scenarios           schema_meta
```

Or use a named volume for cross-machine portability:

```sh
docker volume create ocpp-state
docker run --rm -p 9700:9700 -v ocpp-state:/data ghcr.io/shiv3/ocpp-cp-simulator:latest …
```

To opt out of persistence entirely:

```sh
docker run -e STATE_DB=:memory: ghcr.io/shiv3/ocpp-cp-simulator:latest …
```

See [server.md → State persistence](server.md#state-persistence) for the table catalog and the Reset endpoint.

## docker-compose

`docker-compose.yml` at the repo root wires the persistent volume + sensible defaults:

```sh
# Bring it up (binds ./.state on the host)
docker compose up --build

# Override CP / CSMS / port via env
HTTP_PORT=5172 CP_ID=my-cp CONNECTORS=5 \
  WS_URL=wss://csms.example.com/chargepoint/ \
  docker compose up --build
```

Variables read by the compose file (all optional):

| Variable      | Default                              | Purpose                                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTP_PORT`   | `9700`                               | Host port forwarded to 9700/c                                                                                                                                                                                                                                                                  |
| `CP_ID`       | `cp1`                                | Bootstrap charge point id                                                                                                                                                                                                                                                                      |
| `CONNECTORS`  | `1`                                  | Number of connectors                                                                                                                                                                                                                                                                           |
| `WS_URL`      | `wss://example.invalid/chargepoint/` | CSMS WebSocket URL                                                                                                                                                                                                                                                                             |
| `CORS_ORIGIN` | _(empty → any origin)_               | Restrict CORS (see comments)                                                                                                                                                                                                                                                                   |
| `STATE_DB`    | `/data/state.db`                     | SQLite path inside container                                                                                                                                                                                                                                                                   |
| `HEALTH_PATH` | `/v1/healthz`                        | Daemon health endpoint path. Compose passes it both as `--build-arg` (baked into the UI bundle as `VITE_HEALTH_PATH`) and as a runtime env (forwarded to `--health-path`). Set both sides when a fronting proxy reserves the default — e.g. Cloud Run / GFE returning 404 on the default path. |

## Mounting a scenario template

```sh
docker run --rm -p 9700:9700 \
  -v "$PWD/.state:/data" \
  -v "$PWD/docs/examples/scenarios:/scenarios:ro" \
  ghcr.io/shiv3/ocpp-cp-simulator:latest \
  --cp-id CP001 --ws-url wss://example.invalid/chargepoint/ \
  --scenario-template-file /scenarios/demo-charging.json \
  --scenario-connector all
```

## Structured logs

Pass `--log-format json` (or set `STATE_DB=...` plus the flag) to switch every line on stderr — including `[server] xxx` setup chatter — to JSON Lines. Lines out of the daemon, rows in the `logs` table, and the JSON-Lines file produced by the browser's **Download Logs** button all share the same shape, so one `jq` pipeline consumes all three:

```sh
docker run --rm -p 9700:9700 \
  -v "$PWD/.state:/data" \
  ghcr.io/shiv3/ocpp-cp-simulator:latest \
  --cp-id CP001 --ws-url wss://example.invalid/chargepoint/ \
  --log-format json \
  2>&1 | jq -r 'select(.type=="WebSocket") | "\(.timestamp) \(.message)"'
```

See [server.md → Log format](server.md#log-format) for the schema and the related HTTP endpoints (`GET /v1/cp/:cpId/logs`, `POST /v1/cp/:cpId/logs/clear`).

## Image details

| Aspect            | Value                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Base              | `oven/bun:1-alpine` (multi-stage build)                                                                                 |
| Default user      | `bun` (non-root)                                                                                                        |
| Exposed port      | `9700`                                                                                                                  |
| Volumes           | `/data` (state DB)                                                                                                      |
| Healthcheck       | `GET $HEALTH_PATH` every 30s (default `/v1/healthz`; override via build-arg + env)                                      |
| Bundled scenarios | `/app/docs/examples/scenarios/` (point `--scenario-template-file` at one of these or mount your own under `/scenarios`) |

The image **doesn't** contain Vite / Tauri / dev dependencies — Vite builds the browser UI in a separate stage and only `dist/` ships in the runtime layer.

## Building locally

```sh
docker build -t ocpp-cp-sim:dev .
docker run --rm -p 9700:9700 -v "$PWD/.state:/data" ocpp-cp-sim:dev \
  --cp-id CP001 --ws-url wss://example.invalid/chargepoint/
```

The build is fully self-contained (no host node_modules required); first build ≈ 60 s, subsequent rebuilds hit the Bun install cache for ≈ 10 s.

## Custom health-check path

The daemon's health endpoint defaults to `/v1/healthz`. Override the path when deploying behind a reverse proxy that reserves the default — e.g. Google Front End in front of Cloud Run returning 404 directly on certain paths before the request reaches the container. The same value must be set both at build time (it's inlined into the UI bundle for the browser's Remote-mode auto-detect probe) and at runtime (forwarded to the daemon's `--health-path`):

```sh
# 1) Build with the custom path baked into the UI bundle.
docker build \
  --build-arg HEALTH_PATH=/internal/healthz \
  -t ocpp-cp-sim:custom-health .

# 2) Run with the same path exported as env so the entrypoint passes
#    `--health-path /internal/healthz` to ocpp-cp-sim.
docker run --rm -p 9700:9700 \
  -e HEALTH_PATH=/internal/healthz \
  ocpp-cp-sim:custom-health \
  --cp-id CP001 --ws-url wss://example.invalid/chargepoint/
```

With compose, the same `HEALTH_PATH` env on the host machine flows to both the build args and the container env (see [`docker-compose.yml`](../docker-compose.yml)).
