#!/usr/bin/env bash
# 02-provision.sh -- idempotent DB/SteVe provisioning for certification runs.
#
# Registers charge boxes CERTCP1..3, the CERT-TAG-1..8 pool, every
# scenario-hardcoded idTag (found by grepping the scenario JSONs at runtime,
# so new scenarios are picked up automatically), the two SteVe
# charging-profile entities SmartCharging ops need, and closes any stale
# open transactions left over from an interrupted previous run.
#
# Safe to re-run: every step is INSERT ... ON DUPLICATE KEY UPDATE or an
# existence check first.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

require_cmd docker
require_cmd curl

SCENARIOS_DIR="$REPO_ROOT/src/utils/scenarios"
[ -d "$SCENARIOS_DIR" ] || die "scenarios dir not found: $SCENARIOS_DIR"

_db_ping() { db_scalar "SELECT 1;" >/dev/null 2>&1; }
log_info "waiting for SteVe DB to accept connections (bounded 60s)"
wait_for_condition 60 2 "SteVe DB reachable" -- _db_ping

# ---------------------------------------------------------------------------
# 1. Charge boxes CERTCP1..3
# ---------------------------------------------------------------------------

log_info "registering charge boxes CERTCP1..3"
db "
INSERT INTO charge_box (charge_box_id, ocpp_protocol, registration_status) VALUES
  ('CERTCP1', 'ocpp1.6J', 'Accepted'),
  ('CERTCP2', 'ocpp1.6J', 'Accepted'),
  ('CERTCP3', 'ocpp1.6J', 'Accepted')
ON DUPLICATE KEY UPDATE registration_status = 'Accepted';
" >/dev/null

# ---------------------------------------------------------------------------
# 2. Tags: the CERT-TAG-1..8 pool + CERT-RES01 + every scenario-hardcoded
#    tagId/idTag, discovered by grepping the scenario JSONs so new
#    scenarios are picked up without editing this script.
# ---------------------------------------------------------------------------

log_info "collecting tagId/idTag values referenced by src/utils/scenarios/cert16-*.json"
mapfile -t scenario_tags < <(
  grep -ohE '"(tagId|idTag)"[[:space:]]*:[[:space:]]*"[^"]+"' "$SCENARIOS_DIR"/cert16-*.json |
    sed -E 's/.*"(tagId|idTag)"[[:space:]]*:[[:space:]]*"([^"]+)".*/\2/' |
    sort -u
)
log_info "found ${#scenario_tags[@]} scenario-hardcoded tag(s): ${scenario_tags[*]}"

all_tags=(CERT-TAG-1 CERT-TAG-2 CERT-TAG-3 CERT-TAG-4 CERT-TAG-5 CERT-TAG-6 CERT-TAG-7 CERT-TAG-8 CERT-RES01 "${scenario_tags[@]}")

# Deduplicate while preserving order.
declare -A seen_tag=()
tag_values=""
for t in "${all_tags[@]}"; do
  [ -n "${seen_tag[$t]:-}" ] && continue
  seen_tag["$t"]=1
  tag_values="${tag_values}${tag_values:+, }('$t', 5)"
done

log_info "provisioning $(printf '%s' "$tag_values" | grep -o "('" | wc -l | tr -d ' ') ocpp_tag row(s), max_active_transaction_count=5"
db "
INSERT INTO ocpp_tag (id_tag, max_active_transaction_count) VALUES
  $tag_values
ON DUPLICATE KEY UPDATE max_active_transaction_count = 5;
" >/dev/null

# ---------------------------------------------------------------------------
# 2b. TC_023 Authorize-outcome tags (issue #181): CERT023-{INV,EXP,BLK} come
#     out of the general auto-discovery loop above as ordinary accepted tags
#     (max_active_transaction_count=5, no expiry) -- that's wrong for two of
#     the three, and CERT023-INV must not be a row in ocpp_tag at all. Fix
#     up all three explicitly here so SteVe's Authorize.conf actually
#     returns the outcome each scenario's name promises.
#
#     Confirmed directly against SteVe's decision logic (running
#     steve-app-1 container, src/main/java/de/rwth/idsg/steve/service/
#     AuthTagServiceLocal.java + OcppTagActivityRecordUtils.java):
#       - record == null (no ocpp_tag row for the idTag)      -> INVALID
#       - isBlocked(record): max_active_transaction_count = 0 -> BLOCKED
#       - isExpired(record, now): expiry_date < NOW()         -> EXPIRED
#       - otherwise                                            -> ACCEPTED
#     Blocked is checked before Expired, so the two conditions can't be
#     accidentally conflated by setting both on one row.
# ---------------------------------------------------------------------------

log_info "fixing up TC_023 Authorize-outcome tag states (CERT023-INV/EXP/BLK)"

# CERT023-INV must stay UNKNOWN (no ocpp_tag row) so SteVe's
# AuthTagServiceLocal.decideStatus() returns INVALID -- undo the general
# loop's insert. Safe to re-run: ocpp_tag.id_tag is referenced by
# transaction_start.id_tag with ON DELETE CASCADE (confirmed via
# information_schema.REFERENTIAL_CONSTRAINTS), so this never fails on a
# leftover FK even if a prior run's transaction referenced this tag; correct
# behavior never creates such a row for CERT023-INV in the first place.
db "DELETE FROM ocpp_tag WHERE id_tag = 'CERT023-INV';" >/dev/null

# CERT023-EXP: expiry_date in the past -> isExpired() -> EXPIRED.
db "UPDATE ocpp_tag SET expiry_date = NOW() - INTERVAL 1 DAY WHERE id_tag = 'CERT023-EXP';" >/dev/null

# CERT023-BLK: max_active_transaction_count = 0 -> isBlocked() -> BLOCKED.
db "UPDATE ocpp_tag SET max_active_transaction_count = 0 WHERE id_tag = 'CERT023-BLK';" >/dev/null

# ---------------------------------------------------------------------------
# 3. Charging-profile entities for SmartCharging ops (TC_056/057/059/066/067)
#    -- SetChargingProfile/ClearChargingProfile/RemoteStartTransaction all
#    key off a pre-existing "Charging Profile" entity in SteVe (no ad hoc
#    profile entry on the operation forms themselves). RemoteStartTransaction
#    additionally requires the attached profile's purpose to be exactly
#    TX_PROFILE.
# ---------------------------------------------------------------------------

ensure_charging_profile() {
  local description="$1" purpose="$2" stack_level="$3"
  local existing
  existing="$(db_scalar "SELECT charging_profile_pk FROM charging_profile WHERE description = '$description' LIMIT 1;")"
  if [ -n "$existing" ]; then
    log_info "charging profile '$description' already provisioned (pk=$existing)"
    return 0
  fi

  log_info "creating charging profile '$description' ($purpose)"
  steve_ensure_login
  local add_html csrf
  add_html="$(mktemp)"
  curl -sS -b "$STEVE_JAR" -c "$STEVE_JAR" -m 10 "$STEVE_URL/chargingProfiles/add" -o "$add_html"
  csrf="$(grep -o 'name="_csrf" value="[^"]*"' "$add_html" | sed 's/.*value="\(.*\)"/\1/')"
  rm -f "$add_html"
  [ -n "$csrf" ] || die "could not find CSRF token on $STEVE_URL/chargingProfiles/add"

  # add=Add mirrors the form's <input type="submit" name="add" value="Add">
  # (confirmed on the live SteVe 3.13.0 /chargingProfiles/add page): Spring
  # MVC dispatches this form to the controller's add handler by the presence
  # of that "add" param, not by URL/method alone -- without it the POST is a
  # silent no-op (200, no row inserted, no visible error). See issue #184
  # Finding 3.
  curl -sS -b "$STEVE_JAR" -c "$STEVE_JAR" -m 10 -o /dev/null \
    --data-urlencode "description=$description" \
    --data-urlencode "stackLevel=$stack_level" \
    --data-urlencode "chargingProfilePurpose=$purpose" \
    --data-urlencode "chargingProfileKind=ABSOLUTE" \
    --data-urlencode "recurrencyKind=" \
    --data-urlencode "durationInSeconds=3600" \
    --data-urlencode "chargingRateUnit=W" \
    --data-urlencode "note=cert16 steve-verify" \
    --data-urlencode "schedulePeriods[0].startPeriodInSeconds=0" \
    --data-urlencode "schedulePeriods[0].powerLimit=11000" \
    --data-urlencode "_csrf=$csrf" \
    --data-urlencode "add=Add" \
    "$STEVE_URL/chargingProfiles/add"

  existing="$(db_scalar "SELECT charging_profile_pk FROM charging_profile WHERE description = '$description' LIMIT 1;")"
  [ -n "$existing" ] || die "charging profile '$description' was not created -- check /steve/manager/chargingProfiles for form errors"
  log_info "created charging profile '$description' (pk=$existing)"
}

ensure_charging_profile "TC056 TxDefaultProfile" TX_DEFAULT_PROFILE 0
ensure_charging_profile "TC057 TxProfile" TX_PROFILE 1

# ---------------------------------------------------------------------------
# 4. Close any stale open transactions left over from an interrupted run.
# ---------------------------------------------------------------------------

log_info "checking for stale open transactions on CERTCP1..3"
for cp in CERTCP1 CERTCP2 CERTCP3; do
  db_close_stale_tx "$cp"
done

log_info "provisioning complete."
log_info "next: bun runner/main.ts run <template-id>  (or bun runner/main.ts run-all --group core)"
