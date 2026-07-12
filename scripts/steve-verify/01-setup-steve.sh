#!/usr/bin/env bash
# 01-setup-steve.sh -- idempotent SteVe environment bring-up.
#
# Clones (or reuses) a local SteVe checkout, applies the port-remap + mvnw
# wrapper compose edits documented in the setup recipe, brings the stack up,
# and waits until the manager UI answers. Safe to re-run: every step checks
# current state before changing anything.
#
# Env overrides: see lib.sh (STEVE_REPO_DIR, STEVE_REPO_URL,
# STEVE_APP_HOST_PORT, STEVE_APP_HOST_TLS_PORT, STEVE_DB_HOST_PORT, ...).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

require_cmd docker
require_cmd git
require_cmd curl

log_info "repo root: $REPO_ROOT"
log_info "SteVe checkout: $STEVE_REPO_DIR"

# ---------------------------------------------------------------------------
# 1. Clone or refresh the SteVe checkout
# ---------------------------------------------------------------------------

if [ -d "$STEVE_REPO_DIR/.git" ]; then
  log_info "SteVe checkout already present, leaving as-is (no auto-pull -- local compose edits below would conflict with a hard reset)"
else
  log_info "cloning SteVe into $STEVE_REPO_DIR"
  mkdir -p "$(dirname "$STEVE_REPO_DIR")"
  git clone "$STEVE_REPO_URL" "$STEVE_REPO_DIR"
fi

# ---------------------------------------------------------------------------
# 2. Apply compose edits (idempotent)
# ---------------------------------------------------------------------------
#
# docker-compose.yml's `ports:` lists must carry the actual remap -- compose
# concatenates `ports:` across docker-compose.yml + docker-compose.override.yml
# rather than replacing them, so putting the remap in an override file alone
# would leave the original (possibly colliding) host port bound too. Edited
# via sed with idempotent patterns (matches either the stock port or our own
# already-applied remap, so re-running this script is a no-op the second
# time).

COMPOSE_FILE="$STEVE_REPO_DIR/docker-compose.yml"
COMPOSE_OVERRIDE="$STEVE_REPO_DIR/docker-compose.override.yml"

[ -f "$COMPOSE_FILE" ] || die "no docker-compose.yml found at $COMPOSE_FILE -- unexpected SteVe checkout layout"

log_info "applying port remap to docker-compose.yml (db -> ${STEVE_DB_HOST_PORT}, app -> ${STEVE_APP_HOST_PORT}/${STEVE_APP_HOST_TLS_PORT})"
# Tolerate both quoted and unquoted port lines on every pattern (matches
# the current stock docker-compose.yml's own mix: unquoted "- 3306:3306"
# for db, quoted "- \"8180:8180\"" for app) -- a future upstream change to
# either quoting style would otherwise silently fail to match instead of
# applying the remap, and the "stray duplicate ports:" sanity check below
# would misdiagnose the real cause.
sed -i.bak \
  -e "s/^\( *- \)\"\?[0-9]\+:3306\"\?/\1${STEVE_DB_HOST_PORT}:3306/" \
  -e "s/^\( *- \)\"\?[0-9]\+:8180\"\?/\1\"${STEVE_APP_HOST_PORT}:8180\"/" \
  -e "s/^\( *- \)\"\?[0-9]\+:8443\"\?/\1\"${STEVE_APP_HOST_TLS_PORT}:8443\"/" \
  "$COMPOSE_FILE"
rm -f "$COMPOSE_FILE.bak"

log_info "writing docker-compose.override.yml (mvnw wrapper -- bare ./mvnw fails through the VOLUME-shadowed /code mount)"
cat >"$COMPOSE_OVERRIDE" <<'EOF'
services:
  app:
    command:
      [
        "sh",
        "-c",
        "dockerize -wait tcp://mariadb:3306 -timeout 60s && sh ./mvnw clean package -Pdocker,mariadb -Djdk.tls.client.protocols=TLSv1,TLSv1.1,TLSv1.2 && java -XX:MaxRAMPercentage=85 -jar target/steve.war",
      ]
EOF

# Sanity-check the merged config actually reflects the remap (compose
# concatenation footgun from the recipe -- fail loudly here rather than
# discover it as a "port already in use" error later). Modern `docker
# compose config` emits structured YAML (`published: "18180"` / `target:
# 8180`), not a "host:container" string, so match on the published port
# appearing exactly once (a stray duplicate ports: entry from the
# concatenation footgun would show the *original* port instead/as well).
merged_config="$(cd "$STEVE_REPO_DIR" && docker compose config)"
if ! printf '%s' "$merged_config" | grep -q "published: \"${STEVE_APP_HOST_PORT}\""; then
  die "docker compose config does not show the expected app port remap (published: \"${STEVE_APP_HOST_PORT}\") -- check $COMPOSE_FILE for a stray duplicate ports: entry"
fi

# ---------------------------------------------------------------------------
# 3. Bring the stack up
# ---------------------------------------------------------------------------

log_info "docker compose up -d (first boot does a full Maven build with no ~/.m2 cache -- can take several minutes)"
(cd "$STEVE_REPO_DIR" && docker compose up -d)

log_info "waiting for SteVe manager to answer at $STEVE_URL/signin (bounded 480s -- first-boot Maven build is slow)"
wait_for_http "$STEVE_URL/signin" '^(200|302|303)$' 480 "SteVe manager UI"

log_info "SteVe is up. Network: $STEVE_NETWORK. Manager UI: $STEVE_URL/"
log_info "next: ./02-provision.sh"
