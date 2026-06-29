#!/bin/sh
# Container entrypoint for the ocpp-cp-sim daemon image.
#
# The Dockerfile pre-creates /data with `bun:bun` ownership so an
# anonymous / named volume "just works", but a host bind-mount
# (`docker run -v $PWD/.state:/data …`) re-mounts the host directory on
# top with the host UID/GID — which usually isn't 1000:1000. Without
# this shim we'd get "Fatal: unable to open database file" the first
# time bun:sqlite tried to open /data/state.db.
#
# So we:
#   1. Start as root (image's USER directive is `root` for this reason).
#   2. chown /data to bun:bun if it isn't already writable by bun. Tiny
#      cost on first run; no-op on subsequent runs.
#   3. Drop to the bun user via `su-exec` and exec the simulator.
#   4. Compose the CLI flag bundle:
#        --http-host 0.0.0.0 --unsafe-remote --web-console $HTTP_PORT
#        (--state-db $STATE_DB only when STATE_DB is non-empty).
#        (--health-path $HEALTH_PATH only when HEALTH_PATH is non-empty).
#
# Set STATE_DB=:memory: at runtime to opt out of persistence; set it to
# the empty string to drop the flag entirely.
#
# HEALTH_PATH must match the value passed at image build time as
# `--build-arg HEALTH_PATH=…` because the UI bundle inlines it as
# VITE_HEALTH_PATH; setting only the runtime env will move the daemon
# endpoint but leave the browser probe targeting the build-time default.
set -e

if [ -d /data ] && [ "$(stat -c %u /data 2>/dev/null)" != "1000" ]; then
  # Only chown the mount point itself, not its contents. Any existing
  # files were either written by a previous run (already bun-owned) or
  # belong to whoever owned the host bind-mount; recursive chown across
  # a multi-MB logs / WAL tree adds noticeable startup latency for no
  # gain — bun can write new files once the directory is writable.
  chown bun:bun /data
fi

# --unsafe-remote: the container intentionally binds 0.0.0.0 (non-loopback) so
# the web console / socket.io API are reachable from outside the container.
# The Sec-3 startup guard refuses a non-loopback bind without auth unless this
# explicit opt-in is given; exposure is controlled by Docker port mapping.
ARGS="--http-host 0.0.0.0 --unsafe-remote --web-console ${HTTP_PORT}"
if [ -n "${STATE_DB}" ]; then
  ARGS="${ARGS} --state-db ${STATE_DB}"
fi
if [ -n "${HEALTH_PATH}" ]; then
  ARGS="${ARGS} --health-path ${HEALTH_PATH}"
fi

exec su-exec bun:bun bun src/cli/main.ts ${ARGS} "$@"
