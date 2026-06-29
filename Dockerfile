# syntax=docker/dockerfile:1.7

# Bun-based image for the OCPP CP simulator. Ships both:
#   * the daemon (ocpp-cp-sim) on HTTP
#   * the React browser UI, built with Vite, served as static files from
#     the same HTTP server (SPA-aware fallback to index.html).
#
# Build:
#   docker build -t ocpp-cp-sim .
#
# Run (HTTP on 9700, CSMS at wss://example/chargepoint/, cpId=cp1, 2 connectors):
#   docker run --rm -p 9700:9700 ocpp-cp-sim \
#     --cp-id cp1 --connectors 2 \
#     --ws-url wss://example/chargepoint/
#
# Then open http://localhost:9700/ in a browser — the UI talks to the same
# port for its API + WebSocket events.
#
# Run with a scenario template file mounted in:
#   docker run --rm -p 9700:9700 \
#     -v $PWD/docs/examples/scenarios:/scenarios:ro \
#     ocpp-cp-sim --cp-id cp1 --ws-url wss://example/chargepoint/ \
#       --scenario-template-file /scenarios/demo-charging.json \
#       --scenario-connector all

ARG BUN_VERSION=1
# Health-check URL path. Same value is baked into the UI bundle at build
# time (as VITE_HEALTH_PATH) and re-applied at runtime as the daemon's
# --health-path flag, so the browser's remote-mode auto-detect probe and
# the platform's HTTP liveness probe hit the same endpoint. Override with
# `docker build --build-arg HEALTH_PATH=/your/path .` when deploying
# behind a proxy that reserves the default (e.g. Google Front End in
# front of Cloud Run returning 404 on certain reserved paths).
ARG HEALTH_PATH=/v1/healthz


# ----- Stage 1: build the browser UI (Vite -> dist/) -----------------
FROM oven/bun:${BUN_VERSION}-alpine AS ui
ARG HEALTH_PATH
WORKDIR /app

# Need every dep (including devDependencies: vite, plugins, tailwind).
# --ignore-scripts skips husky/postinstall hooks.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# Source for the UI build: index.html + src/ + Vite/Tailwind/TS configs.
COPY index.html ./
COPY vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json tsconfig.cli.json ./
COPY tailwind.config.js postcss.config.js ./
COPY public ./public
COPY src ./src
# src/ocpp/v{16,201,21}/schemas.ts import the vendored OCA JSON schemas
# (../../../vendor/ocpp-schemas/**). Vite resolves these JSON imports at
# build time, so the vendor tree must be present or `bun run build` fails
# with "Could not resolve ../../../vendor/ocpp-schemas/...".
COPY vendor ./vendor

# VITE_HEALTH_PATH is read by src/data/healthPath.ts at build time and
# inlined into the bundle so the static UI knows which path to probe for
# Remote-mode auto-detect (and for the Navbar's health poll).
ENV VITE_HEALTH_PATH=$HEALTH_PATH
RUN bun run build


# ----- Stage 2: production deps only, for the runtime image ----------
FROM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts


# ----- Stage 3: the runtime image -------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app

# Production node_modules (no React tooling, no Tauri, etc.).
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./

# Only the files the CLI / daemon needs at runtime.
COPY src/cli ./src/cli
COPY src/cp ./src/cp
# src/ocpp holds the self-generated OCPP types/validators. src/cp's transport
# layer statically imports them on the daemon boot path
# (ChargePoint -> profile/profiles -> OCPPMessageHandlerV201 ->
# v201/inboundRegistryV201 -> ocpp/validation/v201), so without it the daemon
# crashes when a charge point is created with a "Cannot find module
# ../../../../ocpp/validation/v201" resolution error.
COPY src/ocpp ./src/ocpp
# The validators above import the vendored OCA JSON schemas
# (src/ocpp/v{16,201,21}/schemas.ts -> ../../../vendor/ocpp-schemas/**); bun
# resolves those JSON imports at runtime, so the vendor tree must ship too.
COPY vendor ./vendor
# src/protocol holds the socket.io control-plane zod schemas imported by the
# daemon (src/cli/server/*). Without it the daemon crashes on boot with a
# "Cannot find package '../../protocol'" resolution error.
COPY src/protocol ./src/protocol
COPY src/data ./src/data
# scenarioTemplates.ts statically imports built-in templates from
# src/utils/scenarios/*.json (extracted in PR #54). Copying the whole utils/
# subtree keeps those imports resolvable at runtime — copying only
# scenarioTemplates.ts left the daemon crashing on boot with
# "Cannot find module './scenarios/essential-cp-behavior.json'".
COPY src/utils ./src/utils

# Built-in scenario examples — kept handy under /app/docs.
COPY docs/examples/scenarios ./docs/examples/scenarios

# The browser UI produced in stage 1.
COPY --from=ui /app/dist ./dist

# Persistent state lands at /data when the operator passes
# `--state-db /data/state.db` (the entrypoint wires this from $STATE_DB).
# Pre-create the directory with bun ownership so anonymous / named
# volumes inherit it. Host bind-mounts (`-v ./.state:/data`) re-mount the
# host's ownership on top, which docker/entrypoint.sh fixes up at runtime.
RUN mkdir -p /data && chown -R bun:bun /app /data

# `su-exec` is a 10 KB Alpine helper that drops to a non-root user
# *without* fork/exec a full shell. We need root briefly at container
# start to chown a bind-mounted /data, then drop to bun.
RUN apk add --no-cache su-exec

# Ship the entrypoint shim. Kept as a file (not inlined as `sh -c …`) so
# it's easy to edit + grep without escaping quotes.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# IMPORTANT: stay as root so the entrypoint can chown /data. The shim
# drops to `bun` via su-exec before exec'ing the simulator.
USER root

# Declare /data as a managed volume so `docker run` without `-v` still
# carves out an anonymous volume — the simulator state survives container
# restart/recreate. Mount a host directory (`docker run -v /host:/data`)
# or named volume (`docker volume create ocpp-state`) for explicit
# control / cross-host portability.
VOLUME ["/data"]

ENV NODE_ENV=production
ENV HTTP_PORT=9700
# Default state-db location inside the volume. Override at run time with
# `-e STATE_DB=:memory:` for ephemeral, or `-e STATE_DB=` to drop the
# flag entirely.
ENV STATE_DB=/data/state.db
# Re-export the build-time HEALTH_PATH as a runtime env so the entrypoint
# can forward it to `--health-path` and so this default is documented next
# to HTTP_PORT / STATE_DB. Override at run time with
# `-e HEALTH_PATH=/your/path` IF the UI bundle was built with the same
# value — they must match for the browser's auto-detect probe to land.
ARG HEALTH_PATH
ENV HEALTH_PATH=$HEALTH_PATH
EXPOSE 9700

# Entrypoint:
#   1. Fix up /data ownership when a host bind-mount overlayed root:root.
#   2. Compose --http-host 0.0.0.0 --unix-socket none --web-console
#      $HTTP_PORT [--state-db $STATE_DB] and append any user CMD args.
#   3. Exec bun src/cli/main.ts as the non-root `bun` user.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# No-args default — the daemon comes up empty; create CPs via POST /v1/cp
# or pass `--cp-id ... --ws-url ...` to `docker run`.
CMD []

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${HTTP_PORT}${HEALTH_PATH}" >/dev/null 2>&1 || exit 1
