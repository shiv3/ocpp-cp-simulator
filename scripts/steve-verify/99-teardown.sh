#!/usr/bin/env bash
# 99-teardown.sh [--volumes] [--containers-only]
#
# Tears down the SteVe stack. By default: `docker compose down` (containers
# + network, DB volume kept -- registered charge boxes/tags survive for the
# next session). `--volumes` also drops the DB volume (loses all
# provisioning; run 02-provision.sh again after). `--containers-only` skips
# compose entirely and just removes any leftover sim-* containers this
# suite may have started.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

DROP_VOLUMES=0
CONTAINERS_ONLY=0

while [ "$#" -gt 0 ]; do
  case "$1" in
  --volumes)
    DROP_VOLUMES=1
    shift
    ;;
  --containers-only)
    CONTAINERS_ONLY=1
    shift
    ;;
  -h | --help)
    echo "Usage: $(basename "$0") [--volumes] [--containers-only]"
    exit 0
    ;;
  *)
    die "unknown argument: $1"
    ;;
  esac
done

log_info "removing any leftover sim-* containers"
mapfile -t leftover < <(docker ps -aq --filter "name=^sim-" 2>/dev/null || true)
if [ "${#leftover[@]}" -gt 0 ]; then
  docker rm -f "${leftover[@]}" >/dev/null 2>&1 || true
  log_info "removed ${#leftover[@]} leftover simulator container(s)"
else
  log_info "no leftover simulator containers"
fi

if [ "$CONTAINERS_ONLY" -eq 1 ]; then
  log_info "--containers-only: leaving SteVe itself running."
  exit 0
fi

if [ ! -d "$STEVE_REPO_DIR" ]; then
  log_warn "no SteVe checkout at $STEVE_REPO_DIR -- nothing to tear down"
  exit 0
fi

if [ "$DROP_VOLUMES" -eq 1 ]; then
  log_info "docker compose down -v (also dropping the DB volume -- next run starts from a clean SteVe DB)"
  (cd "$STEVE_REPO_DIR" && docker compose down -v)
else
  log_info "docker compose down (DB volume kept -- charge_box/ocpp_tag registrations survive)"
  (cd "$STEVE_REPO_DIR" && docker compose down)
fi

log_info "teardown complete."
