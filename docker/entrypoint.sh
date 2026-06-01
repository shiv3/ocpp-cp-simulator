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
#        --http-host 0.0.0.0 --unix-socket none --web-console $HTTP_PORT
#        (--state-db $STATE_DB only when STATE_DB is non-empty).
#
# Set STATE_DB=:memory: at runtime to opt out of persistence; set it to
# the empty string to drop the flag entirely.
set -e

if [ -d /data ] && [ "$(stat -c %u /data 2>/dev/null)" != "1000" ]; then
  chown -R bun:bun /data
fi

ARGS="--http-host 0.0.0.0 --unix-socket none --web-console ${HTTP_PORT}"
if [ -n "${STATE_DB}" ]; then
  ARGS="${ARGS} --state-db ${STATE_DB}"
fi

exec su-exec bun:bun bun src/cli/main.ts ${ARGS} "$@"
