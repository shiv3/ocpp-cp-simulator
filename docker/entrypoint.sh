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
#   3. Drop to the bun user via `su-exec` and exec the simulator (daemon mode only).
#   4. Compose the CLI flag bundle:
#        --http-host 0.0.0.0 --unsafe-remote --web-console $HTTP_PORT
#        (--state-db $STATE_DB only when STATE_DB is non-empty).
#        (--health-path $HEALTH_PATH only when HEALTH_PATH is non-empty).
#
# CLI mode (#346): the same image also runs the CLI itself, for callers that
# drive JSON mode over stdin (open-ocpp-tck) or use a subcommand, without
# `--entrypoint`. The entrypoint passes the arguments straight to
# `bun dist-cli/main.js`, with none of the daemon flags above, when
#   * the first argument is `cli` (explicit; it is dropped), `analyze`,
#     `export-k6` or `behavior`, or
#   * `--json` appears among the arguments (JSON mode is a stdin protocol
#     and never serves HTTP).
# Everything else, including a flag-first command line such as
# `--cp-id cp1 --ws-url …`, still starts the daemon. STATE_DB and HEALTH_PATH
# do not apply in CLI mode. CLI mode does not drop to `bun` (no su-exec, no
# chown): it runs as the user the container was started as (root by default,
# or `docker run --user`), so a mounted host directory is written with that
# identity. See docs/entities/docker-image.md#running-the-cli.
#
# OCPP_ENTRYPOINT_DRY_RUN=1 prints the argv that would be exec'd (one word per
# line) and exits; the entrypoint test uses it, since it cannot exec su-exec or touch /tmp.
#
# Set STATE_DB=:memory: at runtime to opt out of persistence; set it to
# the empty string to drop the flag entirely.
#
# HEALTH_PATH must match the value passed at image build time as
# `--build-arg HEALTH_PATH=…` because the UI bundle inlines it as
# VITE_HEALTH_PATH; setting only the runtime env will move the daemon
# endpoint but leave the browser probe targeting the build-time default.
set -e

cli_mode() {
  case "${1-}" in
    cli | analyze | export-k6 | behavior) return 0 ;;
  esac
  for arg in "$@"; do
    [ "$arg" = "--json" ] && return 0
  done
  return 1
}

if cli_mode "$@"; then
  [ "${1-}" = "cli" ] && shift
  if [ -n "${OCPP_ENTRYPOINT_DRY_RUN-}" ]; then
    printf '%s\n' bun dist-cli/main.js "$@"
    exit 0
  fi
  # CLI mode keeps the caller's identity: no su-exec, no chown. A host
  # directory mounted for `--trace-output` or a 0600 key file belongs to the
  # host user, and `--user` only works when the entrypoint does not need root.
  # The HEALTHCHECK looks for this marker and passes: there is no daemon.
  touch /tmp/.ocpp-cli-mode 2>/dev/null || true
  exec bun dist-cli/main.js "$@"
fi

if [ -z "${OCPP_ENTRYPOINT_DRY_RUN-}" ] && [ -d /data ] && [ "$(stat -c %u /data 2>/dev/null)" != "1000" ]; then
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

if [ -n "${OCPP_ENTRYPOINT_DRY_RUN-}" ]; then
  # shellcheck disable=SC2086
  printf '%s\n' bun dist-cli/main.js ${ARGS} "$@"
  exit 0
fi

exec su-exec bun:bun bun dist-cli/main.js ${ARGS} "$@"
