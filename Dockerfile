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


# ----- Stage 1: build the browser UI (Vite -> dist/) -----------------
FROM oven/bun:${BUN_VERSION}-alpine AS ui
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
COPY src/utils/scenarioTemplates.ts ./src/utils/scenarioTemplates.ts

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
  CMD wget -qO- "http://127.0.0.1:${HTTP_PORT}/healthz" >/dev/null 2>&1 || exit 1
