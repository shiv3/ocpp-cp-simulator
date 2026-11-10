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

# Bun for the build and runtime stages. Must match the bun line of
# .tool-versions, the single source of the Bun version (mise, every
# workflow): the image runs the Bun the tests ran on, not whatever 1.x
# is latest. The workflows pass the value read from .tool-versions;
# scripts/__tests__/bunVersionPin.bun.test.ts fails when this default
# drifts. Override with --build-arg BUN_VERSION=<x.y.z>.
ARG BUN_VERSION=1.4.3
# Health-check URL path. Same value is baked into the UI bundle at build
# time (as VITE_HEALTH_PATH) and re-applied at runtime as the daemon's
# --health-path flag, so the browser's remote-mode auto-detect probe and
# the platform's HTTP liveness probe hit the same endpoint. Override with
# `docker build --build-arg HEALTH_PATH=/your/path .` when deploying
# behind a proxy that reserves the default (e.g. Google Front End in
# front of Cloud Run returning 404 on certain reserved paths).
ARG HEALTH_PATH=/v1/healthz
# Commit the image is built from. A tag build stamps package.json with the
# release semver, which wins; a branch build (docker-publish.yml passes
# `github.sha`) reports `<sha7>-dev` in both the UI label and the daemon
# version, and a build without it reports `local-dev`. Pass it when building
# from source: `docker build --build-arg APP_COMMIT=$(git rev-parse HEAD) .`
ARG APP_COMMIT=""


# ----- Stage 1: build the browser UI and the CLI bundle ---------------
# One stage builds both artifacts the runtime image ships:
#   dist/            the web console (Vite)
#   dist-cli/main.js the CLI + daemon as one `bun build` bundle (#578)
FROM oven/bun:${BUN_VERSION}-alpine AS build
ARG HEALTH_PATH
WORKDIR /app

# Need every dep (including devDependencies: vite, plugins, tailwind).
# --ignore-scripts skips husky/postinstall hooks. bunfig.toml pins the hoisted
# linker, and `bun install --frozen-lockfile` needs every workspace member's
# package.json to match bun.lock, so the manifests come first and the install
# layer stays cached until one of them (or the lockfile) changes.
COPY package.json bun.lock bunfig.toml ./
COPY packages/ocpp/package.json ./packages/ocpp/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/trace/package.json ./packages/trace/package.json
COPY packages/k6-runtime/package.json ./packages/k6-runtime/package.json
COPY packages/vehicle/package.json ./packages/vehicle/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/client/package.json ./packages/client/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/web/package.json ./apps/web/package.json
# `bun install` reaches the network for every package, and a transient
# tarball-extraction failure there fails the whole build:
#
#   error: Fail extracting tarball for "@swc/core-linux-arm64-gnu"
#
# That is what left v0.7.6 without a published image (#281) — the tag build
# is a one-shot, so a hiccup that a re-run would have survived becomes a
# release whose notes promise an image the registry does not have. Retry a
# few times with a short backoff, and clear bun's cache between attempts so
# a half-extracted entry is not reused. A genuine failure (a lockfile that
# does not match, a package that does not exist) still fails, three times
# and roughly 20 seconds slower.
# @open-ocpp-trace/* comes from GitHub Packages, which asks for a token even
# for a public package (bunfig.toml): pass one as the `github_token` secret,
#   docker build --secret id=github_token,env=GITHUB_TOKEN .
# A secret mount never lands in a layer or in the image history.
RUN --mount=type=secret,id=github_token \
    [ -s /run/secrets/github_token ] || { echo "missing the github_token build secret (a token with read:packages): docker build --secret id=github_token,env=GITHUB_TOKEN ."; exit 1; }; \
    export GITHUB_TOKEN="$(cat /run/secrets/github_token)"; \
    for attempt in 1 2 3; do \
      bun install --frozen-lockfile --ignore-scripts && break; \
      [ "$attempt" = 3 ] && { echo "bun install failed 3 times; giving up"; exit 1; }; \
      echo "bun install failed (attempt $attempt/3); retrying"; \
      rm -rf /root/.bun/install/cache node_modules; \
      sleep $((attempt * 5)); \
    done

# Source for both builds: index.html + the Vite/Tailwind/TS configs, then the
# workspace. The root tsconfig.json references every package's tsconfig and
# scripts/bench/tsconfig.json (#302, composite projects); Vite's rolldown
# resolves each reference at build time, so the files must be present or
# `bun run build` fails with "Tsconfig not found" — which is how the v0.7.11
# image never built. Only that tsconfig is needed from scripts/, not the bench
# code. Everything a package imports (the vendored OCA schemas under
# packages/ocpp/vendor, the scenario schema under packages/core/schema) lives
# inside its package, so copying the two directories is the whole list; the
# hand-maintained per-directory COPY lines of the source-based image are gone.
COPY index.html ./
COPY vite.config.ts tsconfig.json tsconfig.base.json tsconfig.node.json ./
COPY scripts/bench/tsconfig.json ./scripts/bench/tsconfig.json
# Same for scripts/tsconfig.json (#578, the package-boundary checker's
# project): referenced from the root tsconfig.json, so it must be present.
COPY scripts/tsconfig.json ./scripts/tsconfig.json
# vite.config.ts imports the third-party notices renderer (#857).
COPY scripts/licenseNotices.ts ./scripts/licenseNotices.ts
# `bun run build:cli` writes the CLI bundle's notices with this (#870).
COPY scripts/generate-cli-notices.ts ./scripts/generate-cli-notices.ts
COPY tailwind.config.js postcss.config.js ./
COPY public ./public
COPY packages ./packages
COPY apps ./apps

# VITE_HEALTH_PATH is read by apps/web/src/data/healthPath.ts at build time and
# inlined into the bundle so the static UI knows which path to probe for
# Remote-mode auto-detect (and for the Navbar's health poll).
ENV VITE_HEALTH_PATH=$HEALTH_PATH
# Declared after the install layers so a new commit only rebuilds from here.
# vite.config.ts reads APP_COMMIT into the bundle's build label; the CLI
# bundle inlines package.json's version the same way and reads APP_COMMIT at
# run time (see the runtime stage).
ARG APP_COMMIT
ENV APP_COMMIT=$APP_COMMIT
# Opt-in console error reporting (#794): empty by default, so the published
# image reports nothing. VITE_ERROR_REPORTER selects a built-in adapter
# (sentry), whose own variables follow. Vite bakes them into the bundle, so
# runtime OCPP_SIM_ERROR_REPORTER / SENTRY_DSN on the container cover the
# daemon only.
ARG VITE_ERROR_REPORTER=""
ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_ENVIRONMENT=""
RUN bun run build && bun run build:cli


# ----- Stage 2: the runtime image -------------------------------------
# The CLI is one bundle with every dependency inlined, so the image carries
# no node_modules, no package.json and no sources: dist-cli/main.js, dist/
# and the scenario examples. (apps/cli/src/build/__tests__/cliBundle.bun.test.ts
# runs the bundle with nothing else around it, charge point included.)
FROM oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app

COPY --from=build /app/dist-cli ./dist-cli

# Built-in scenario examples — kept handy under /app/docs.
COPY docs/examples/scenarios ./docs/examples/scenarios

# The browser UI produced in stage 1. main.ts finds it at ../dist from the
# bundle (<pkg>/dist-cli -> <pkg>/dist).
COPY --from=build /app/dist ./dist

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

# `bun src/cli/main.ts …` keeps working for callers that still override the
# entrypoint with it (open-ocpp-tck, #346): a shim that runs the bundle. New
# callers use `docker run -i <image> --json …`, see docker/entrypoint.sh.
RUN mkdir -p /app/src/cli
COPY docker/cli-shim.ts /app/src/cli/main.ts

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
# The daemon runs from source with no .git, so the commit must reach it as a
# runtime env too — otherwise the UI says `<sha7>-dev` next to a daemon that
# says `local-dev` (apps/cli/src/appVersion.ts).
ARG APP_COMMIT
ENV APP_COMMIT=$APP_COMMIT
EXPOSE 9700

# Entrypoint:
#   1. Fix up /data ownership when a host bind-mount overlayed root:root.
#   2. Compose --http-host 0.0.0.0 --unix-socket none --web-console
#      $HTTP_PORT [--state-db $STATE_DB] and append any user CMD args.
#   3. Exec bun dist-cli/main.js as the non-root `bun` user.
# When the first argument is `cli`, `analyze`, `export-k6` or `behavior`, or
# `--json` is among the arguments, step 2 is skipped and the arguments go to
# the CLI as they are (JSON mode over stdin, subcommands), without su-exec so
# the caller's identity (`--user`, mounted host directories) is kept; #346.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# No-args default — the daemon comes up empty; create CPs via POST /v1/cp
# or pass `--cp-id ... --ws-url ...` to `docker run`.
CMD []

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD [ -e /tmp/.ocpp-cli-mode ] || wget -qO- "http://127.0.0.1:${HTTP_PORT}${HEALTH_PATH}" >/dev/null 2>&1 || exit 1
