#!/usr/bin/env bash
#
# Point `cli-latest` at the highest published CLI release.
#
# Usage: scripts/roll-cli-latest.sh <triggering-version> <triggering-tag>
#   e.g. scripts/roll-cli-latest.sh 0.4.0 cli-v0.4.0
#
# Env:
#   GH_TOKEN       required by `gh`
#   REPO_SLUG      owner/name to act on (default: shiv3/ocpp-cp-simulator)
#   DRY_RUN=1      print the mutating commands instead of running them
#   API_ATTEMPTS   retries per mutating API call (default 4)
#
# ---------------------------------------------------------------------------
# THE CONTRACT
#
#   `cli-latest` always serves the highest published `cli-vX.Y.Z` release, and
#   never a lower one, whatever order the pointer jobs run in or fail in.
#
# Carve-outs, stated rather than accidental:
#   * A CLI release tagged with a SemVer prerelease or build-metadata suffix
#     (`cli-v1.0.0-rc.1`) is not eligible to own the pointer and is ignored
#     when picking the highest. Install those by their pinned URL.
#   * If the highest release is later deleted, the pointer follows the new
#     highest downwards, with a `::warning::`. An unpublished release cannot be
#     the thing the pointer serves. Moving down NEVER happens on the strength
#     of a listing alone — see "the marker is load-bearing, narrowly" below.
#   * There is a brief window, bounded by two metadata calls, in which the URL
#     can 404 while the asset is swapped. GitHub offers no atomic asset
#     replacement; the window is made as small as the API allows and is
#     recovered from rather than exited from.
#
# ---------------------------------------------------------------------------
# WHY IT ROLLS TO THE HIGHEST PUBLISHED RELEASE RATHER THAN TO ITS OWN
#
# The obvious design — each run moves the pointer to the version that triggered
# it, refusing if a marker in the pointer's body names something newer — fails
# two ways, and both shipped before this:
#
#   1. The queue is not ordered by version. GitHub keeps exactly ONE pending
#      job per concurrency group and replaces it with the most recently queued
#      one; queue order is release-job completion order. With 1.1 running, 1.3
#      pending and a slow rerun of 1.2 arriving, 1.2's job evicts 1.3's, 1.2
#      advances the pointer from 1.1, and the published 1.3 is never served.
#   2. The marker is not trustworthy as an ordering authority. Upload and
#      marker-write are two API calls: if the upload lands and the write does
#      not, the URL serves the new asset while the body still names the old
#      version, and a later older run passes its comparison against that stale
#      marker and rolls the served bytes backwards. Reversing the two calls
#      only swaps which direction is wrong.
#
# Converging on the highest published release removes both, because it removes
# the two things that were being trusted.
#
# ---------------------------------------------------------------------------
# THE MARKER IS LOAD-BEARING, NARROWLY
#
# Converging on "the highest published release" is only as good as the listing
# it is computed from, and `gh release list` is eventually consistent. Waiting
# until the listing shows the TRIGGERING tag closes "the listing has not caught
# up with me". It does not close "the listing has not caught up with someone
# NEWER": an older rerun can see a listing that looks complete, omits a higher
# release, and would then overwrite the pointer downwards — recreating the
# rollback this design exists to prevent.
#
# In that situation the marker in the pointer's body is the only evidence the
# newer release exists. So the marker IS consulted, in exactly one way: as a
# lower bound on what has already been served. It can never authorise a move by
# itself. Whenever it names something higher than the listing did, the script
# does a point lookup of that release — a direct GET of one tag, not a
# paginated list — and:
#   * published        -> the listing was stale; converge UP to it instead
#   * confirmed 404    -> genuinely deleted; converge down, with a warning
#   * draft            -> not published; converge down, with a warning
#   * any other error  -> fail closed, leave the pointer alone
# So a hand-edited or corrupt marker cannot move the pointer anywhere: it can
# only trigger a lookup whose answer decides.
#
# ---------------------------------------------------------------------------
# "IF THIS DIES HERE, WHAT DOES THE INSTALL URL SERVE?"
#
# Asked of every mutating call, because three review rounds on this script
# found partial-failure bugs rather than logic bugs:
#
#   call                     URL then serves    next run concludes
#   ------------------------ ------------------ ------------------------------
#   gh release download      previous release   nothing changed
#   gh release edit (marker) previous release   marker over-claims -> its point
#                                               lookup finds the release
#                                               published, converges UP, and
#                                               completes this swap
#   upload <asset>.incoming  previous release   same as above
#   delete-asset <asset>     *** 404 window *** same as above
#   PATCH asset name         new release        consistent
#   git ref update           new release        consistent
#
# The second column is the half the failure table used to cover. The third is
# where two rounds of findings actually lived: a state is only safe if the NEXT
# run cannot draw a wrong conclusion from what it finds. That is why the marker
# is written FIRST and why failing to write it is fatal — see step 4a.
#
# THE THIRD CLASS: "IT MAY HAVE SUCCEEDED AND WE CANNOT TELL"
#
# Distinct from "it failed" and "it failed partway". A retry loop cannot tell a
# lost REQUEST from a lost RESPONSE, so an exhausted retry does NOT mean the
# mutation was not applied. The rule everywhere below: after an exhausted retry
# of a mutation, QUERY the state; never assume it. Assuming a rename had failed
# is what let the destructive `--clobber` fallback run against an asset the
# rename had in fact already put in place — turning a cosmetic retry failure
# into a dead install URL.
#
# Where each exhausted retry lands:
#   release edit (marker) -> die. Safe either way: if it was applied, the
#                            marker over-claims, which is self-healing.
#   upload .incoming      -> die. Safe either way: if it was applied, the
#                            orphan serves nothing and the next run clobbers it.
#   delete-asset (live)   -> QUERY. Present: stop. Absent: continue. Unknown: stop.
#   PATCH rename          -> QUERY. Present: it worked. Absent: fall back.
#                            Unknown: stop, never run the destructive fallback.
#   upload (fallback)     -> QUERY, so a lost response is not reported as a
#                            dead URL.
#   release create        -> QUERY, same reason.
#   git ref update        -> QUERY, to keep the warning honest. Cosmetic.
#
# `gh release upload --clobber` is NOT used for the live asset: it deletes the
# existing asset and then uploads, and its own help says "If the upload fails,
# the original assets will be lost" — a failed upload would leave the URL
# README advertises 404ing indefinitely. Instead the new bytes are uploaded
# under a temporary name FIRST, so the destructive step never runs until the
# replacement is already on the server; then delete + rename, both of which are
# fast metadata calls, both retried, and with an explicit recovery that
# re-uploads under the live name if the rename cannot be completed.
set -euo pipefail

VERSION="${1:?usage: roll-cli-latest.sh <triggering-version> <triggering-tag>}"
TAG="${2:?usage: roll-cli-latest.sh <triggering-version> <triggering-tag>}"
REPO_SLUG="${REPO_SLUG:-shiv3/ocpp-cp-simulator}"
DRY_RUN="${DRY_RUN:-0}"
POINTER_TAG="cli-latest"
ASSET_NAME="ocpp-cp-simulator.tgz"
INCOMING_NAME="${ASSET_NAME}.incoming"
MARKER_PREFIX="<!-- cli-latest-version:"
LIST_ATTEMPTS="${LIST_ATTEMPTS:-6}"
LIST_BACKOFF="${LIST_BACKOFF:-5}"
API_ATTEMPTS="${API_ATTEMPTS:-4}"
API_BACKOFF="${API_BACKOFF:-5}"

run() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "DRY_RUN: $*"
  else
    "$@"
  fi
}

die() {
  echo "::error::$*" >&2
  exit 1
}

# Retry a mutating call. Returns non-zero when every attempt failed, so the
# caller decides whether that is fatal or recoverable — never `set -e`'s job.
gh_retry() {
  local what="$1"
  shift
  local n=1
  while :; do
    if run "$@"; then
      return 0
    fi
    if [ "$n" -ge "$API_ATTEMPTS" ]; then
      echo "${what}: failed after ${n} attempts" >&2
      return 1
    fi
    echo "${what}: attempt ${n}/${API_ATTEMPTS} failed; retrying"
    sleep "$API_BACKOFF"
    n=$((n + 1))
  done
}

# 0 = present, 1 = confirmed absent, 2 = could not determine.
#
# A retry loop cannot tell a lost REQUEST from a lost RESPONSE. When a mutation
# reports failure after exhausting its retries, it may in fact have been
# applied. So the rule on this script is: after an exhausted retry of a
# mutation, QUERY the state, never assume it. Assuming failure is how a
# successful rename ended up triggering a destructive `--clobber` against a
# live, working asset.
asset_state() {
  local id
  if id="$(asset_id "$1")"; then
    [ -n "$id" ] && return 0
    return 1
  fi
  return 2
}

# Only plain X.Y.Z, so the numeric comparison is total and exact over the whole
# accepted domain. `sort -V` is deliberately never used: it is not SemVer-aware
# and orders 1.0.0-rc.1 AFTER 1.0.0.
is_release_version() {
  case "$1" in
    *[!0-9.]* | .* | *. | *..*) return 1 ;;
  esac
  [ "$(printf '%s' "$1" | awk -F. '{print NF}')" = 3 ]
}

# 0 when $1 is strictly newer than $2.
version_gt() {
  awk -v a="$1" -v b="$2" '
    BEGIN {
      na = split(a, x, ".");
      nb = split(b, y, ".");
      for (i = 1; i <= 3; i++) {
        xi = (i <= na ? x[i] + 0 : 0);
        yi = (i <= nb ? y[i] + 0 : 0);
        if (xi > yi) exit 0;
        if (xi < yi) exit 1;
      }
      exit 1;
    }'
}

if ! is_release_version "$VERSION"; then
  die "refusing to move ${POINTER_TAG} for '${VERSION}': only plain X.Y.Z releases may own the rolling pointer. A SemVer prerelease or build-metadata version (1.0.0-rc.1, 1.0.0+build) cannot be ordered against a stable one, and ordering it wrongly would move the pointer backwards. Publish it as a pinned ${TAG} release only."
fi

# ---------------------------------------------------------------------------
# 1. Highest published cli-vX.Y.Z, with the triggering version as a floor.
#    Fails closed: a listing that cannot be read stops the run.
# ---------------------------------------------------------------------------
TARGET="$VERSION"
LISTING=""
attempt=1
while :; do
  if ! LISTING="$(gh release list --repo "$REPO_SLUG" --limit 200 \
    --json tagName,isDraft --jq '.[] | select(.isDraft | not) | .tagName' 2>/tmp/roll-gh-err.$$)"; then
    GH_ERR="$(cat /tmp/roll-gh-err.$$ 2>/dev/null || true)"
    rm -f /tmp/roll-gh-err.$$
    die "could not list the releases of ${REPO_SLUG}, so the highest published CLI release is unknown and ${POINTER_TAG} must not be moved. Underlying error: ${GH_ERR}"
  fi
  rm -f /tmp/roll-gh-err.$$
  if printf '%s\n' "$LISTING" | grep -qxF "$TAG"; then
    break
  fi
  if [ "$attempt" -ge "$LIST_ATTEMPTS" ]; then
    echo "::warning::the release listing still does not show ${TAG} after ${LIST_ATTEMPTS} attempts; continuing with ${VERSION} as the floor"
    break
  fi
  echo "release listing does not show ${TAG} yet (attempt ${attempt}/${LIST_ATTEMPTS}); retrying"
  sleep "$LIST_BACKOFF"
  attempt=$((attempt + 1))
done

while IFS= read -r tag; do
  case "$tag" in
    cli-v*) candidate="${tag#cli-v}" ;;
    *) continue ;;
  esac
  is_release_version "$candidate" || continue
  if version_gt "$candidate" "$TARGET"; then
    TARGET="$candidate"
  fi
done <<EOF
$LISTING
EOF

# ---------------------------------------------------------------------------
# 2. What does the pointer say it serves? Fails closed on anything but a
#    confirmed 404, because the create-vs-update branch depends on the answer.
# ---------------------------------------------------------------------------
POINTER_EXISTS=0
BODY=""
if BODY="$(gh api "repos/${REPO_SLUG}/releases/tags/${POINTER_TAG}" --jq '.body // ""' 2>/tmp/roll-gh-err.$$)"; then
  POINTER_EXISTS=1
else
  GH_ERR="$(cat /tmp/roll-gh-err.$$ 2>/dev/null || true)"
  case "$GH_ERR" in
    *"HTTP 404"* | *"Not Found"*)
      echo "${POINTER_TAG} does not exist yet (HTTP 404); it will be created"
      ;;
    *)
      rm -f /tmp/roll-gh-err.$$
      die "could not read ${POINTER_TAG}, and it was not a 404, so it is unknown whether it must be created or updated. Refusing to touch it. Underlying error: ${GH_ERR}"
      ;;
  esac
fi
rm -f /tmp/roll-gh-err.$$

CURRENT=""
if [ "$POINTER_EXISTS" = 1 ]; then
  # `|| true`: under `set -o pipefail` a grep that matches nothing would fail
  # the assignment and kill the script — the state a hand-created pointer is in.
  CURRENT="$(printf '%s\n' "$BODY" \
    | grep -oE "$MARKER_PREFIX [^ ]+ -->" \
    | head -n 1 \
    | sed -E "s/^.*: (.+) -->$/\1/" || true)"
fi

# ---------------------------------------------------------------------------
# 3. Reconcile a marker that claims something higher than the listing showed.
#    NEVER move down on the strength of a listing alone — the listing is the
#    thing that can be stale. One point lookup settles it.
# ---------------------------------------------------------------------------
if [ -n "$CURRENT" ] && ! is_release_version "$CURRENT"; then
  echo "::warning::${POINTER_TAG}'s version marker reads '${CURRENT}', which is not a plain X.Y.Z version; ignoring it and overwriting with ${TARGET}."
elif [ -n "$CURRENT" ] && version_gt "$CURRENT" "$TARGET"; then
  RECORDED_TAG="cli-v${CURRENT}"
  echo "${POINTER_TAG} records ${CURRENT}, higher than anything the listing showed (${TARGET}); confirming whether ${RECORDED_TAG} is still published"
  if RECORDED_DRAFT="$(gh api "repos/${REPO_SLUG}/releases/tags/${RECORDED_TAG}" --jq '.draft' 2>/tmp/roll-gh-err.$$)"; then
    rm -f /tmp/roll-gh-err.$$
    if [ "$RECORDED_DRAFT" = "true" ]; then
      echo "::warning::${RECORDED_TAG} exists but is a draft, so it is not published; ${POINTER_TAG} follows the published releases down to ${TARGET}."
    else
      echo "::notice::the release listing was stale — ${RECORDED_TAG} is published but was not listed. Converging up to ${CURRENT} instead of moving the pointer backwards."
      TARGET="$CURRENT"
    fi
  else
    GH_ERR="$(cat /tmp/roll-gh-err.$$ 2>/dev/null || true)"
    rm -f /tmp/roll-gh-err.$$
    case "$GH_ERR" in
      *"HTTP 404"* | *"Not Found"*)
        echo "::warning::${RECORDED_TAG} is confirmed gone (HTTP 404); it was deleted, so ${POINTER_TAG} follows the published releases down to ${TARGET}."
        ;;
      *)
        die "${POINTER_TAG} records ${CURRENT}, which is higher than anything the listing showed, and ${RECORDED_TAG} could not be checked (not a 404). Moving the pointer now could roll it backwards. Refusing. Underlying error: ${GH_ERR}"
        ;;
    esac
  fi
fi

TARGET_TAG="cli-v${TARGET}"
if [ "$TARGET" = "$VERSION" ]; then
  echo "highest published CLI release is ${TARGET_TAG} (the release that triggered this run)"
else
  echo "::notice::${TAG} triggered this run; ${TARGET_TAG} is the release ${POINTER_TAG} must serve"
fi

# ---------------------------------------------------------------------------
# 4. Take the asset from the target release itself, so the bytes the pointer
#    serves are provably the bytes that release published.
# ---------------------------------------------------------------------------
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/roll-cli-latest.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT
run gh release download "$TARGET_TAG" --repo "$REPO_SLUG" \
  --pattern "$ASSET_NAME" --dir "$WORKDIR" --clobber
if [ "$DRY_RUN" = 1 ] && [ ! -s "$WORKDIR/$ASSET_NAME" ]; then
  printf 'dry-run placeholder\n' > "$WORKDIR/$ASSET_NAME"
fi
[ -s "$WORKDIR/$ASSET_NAME" ] \
  || die "${TARGET_TAG} does not carry a non-empty ${ASSET_NAME}; refusing to point ${POINTER_TAG} at a release whose asset cannot be served."
cp "$WORKDIR/$ASSET_NAME" "$WORKDIR/$INCOMING_NAME"

NOTES="Rolling pointer to the highest published CLI release (currently **${TARGET_TAG}**).

\`\`\`sh
bun install -g https://github.com/${REPO_SLUG}/releases/download/${POINTER_TAG}/${ASSET_NAME}
\`\`\`

Release notes and per-version tarballs live on the \`cli-v*\` releases.
Kept as a pre-release so it never becomes the repository's \"Latest\" release —
the desktop \`v*\` train owns that badge (#321).

${MARKER_PREFIX} ${TARGET} -->"

# $1 = asset name. Prints the id, or nothing when the asset is absent.
# Returns 0 ONLY when a query actually succeeded, so "no output" can be told
# apart from "could not ask". Suppressing that distinction is the fail-open
# class this script closes everywhere else, and it was reintroduced here in the
# recovery path built to prevent exactly the outcome it causes: reading a failed
# lookup as "absent" lets the destructive fallback run against a live, working
# asset.
asset_id() {
  local out n=1
  while :; do
    if out="$(gh api "repos/${REPO_SLUG}/releases/tags/${POINTER_TAG}" \
      --jq ".assets[] | select(.name == \"$1\") | .id" 2>/dev/null)"; then
      printf '%s' "$out" | head -n 1
      return 0
    fi
    if [ "$n" -ge "$API_ATTEMPTS" ]; then
      return 1
    fi
    sleep "$API_BACKOFF"
    n=$((n + 1))
  done
}

if [ "$POINTER_EXISTS" = 0 ]; then
  if ! gh_retry "creating ${POINTER_TAG}" \
    gh release create "$POINTER_TAG" --repo "$REPO_SLUG" --prerelease \
    --title "CLI (rolling latest)" --notes "$NOTES" "$WORKDIR/$ASSET_NAME"; then
    # It may have been created and only the response lost. Ask before reporting.
    CREATED=0
    asset_state "$ASSET_NAME" || CREATED=$?
    case "$CREATED" in
      0) echo "::notice::creating ${POINTER_TAG} reported failure, but ${ASSET_NAME} is present on it — the request had been applied and only its response was lost." ;;
      *) die "could not create ${POINTER_TAG}. No pointer existed before this run, so the install URL is unchanged (still absent)." ;;
    esac
  fi
else
  # --- 4a. the marker, BEFORE anything else changes ------------------------
  # This used to be written last, on the round-3 reasoning that a marker
  # written first could over-claim — name a version whose bytes never landed —
  # and that the guard would then trust it. That reasoning stopped holding in
  # round 4, when the stale-listing fix made every use of the marker go through
  # a point lookup of the release it names. The claim is now VERIFIED before it
  # can be acted on, which reverses which direction of staleness is dangerous:
  #
  #   over-claiming (marker ahead of the bytes)  -> the next run's lookup finds
  #     that release published, converges UP to it, and completes the swap.
  #     Self-healing.
  #   under-claiming (marker behind the bytes)   -> a later run on a stale
  #     listing sees nothing higher to verify, and replaces the newer bytes
  #     with an older tarball. A rollback — the thing this script exists to
  #     prevent.
  #
  # So the marker is advanced first and its failure is fatal: at that point
  # nothing has changed, the URL still serves the previous release, and failing
  # costs nothing. Writing it last and warning would leave a successful swap
  # with a marker that permits a rollback, which is the one state that must not
  # be allowed to exit 0.
  gh_retry "recording ${TARGET} in the ${POINTER_TAG} release notes" \
    gh release edit "$POINTER_TAG" --repo "$REPO_SLUG" --prerelease \
    --title "CLI (rolling latest)" --notes "$NOTES" \
    || die "could not record ${TARGET} in ${POINTER_TAG}'s release notes. Nothing else has been touched, so the install URL still serves the previous release and the marker still names it. Re-run."

  # --- 4b. new bytes onto the server under a name nothing serves -----------
  # --clobber here only ever removes a stale `.incoming` orphaned by an
  # earlier crashed run; the live asset is a different name and is untouched.
  gh_retry "uploading ${INCOMING_NAME}" \
    gh release upload "$POINTER_TAG" "$WORKDIR/$INCOMING_NAME" --repo "$REPO_SLUG" --clobber \
    || die "could not upload the replacement asset for ${POINTER_TAG}. Nothing was deleted, so ${ASSET_NAME} still serves the previous release; the marker names ${TARGET} and the next run will converge to it."

  # --- 4c. the only destructive step, and the only 404 window --------------
  if ! gh_retry "deleting the live ${ASSET_NAME}" \
    gh release delete-asset "$POINTER_TAG" "$ASSET_NAME" --repo "$REPO_SLUG" --yes; then
    if LIVE_ID="$(asset_id "$ASSET_NAME")"; then
      if [ -n "$LIVE_ID" ]; then
        die "could not delete the live ${ASSET_NAME} from ${POINTER_TAG}. It is still present, so the install URL still serves the previous release; the staged ${INCOMING_NAME} is harmless and the next run will reuse it."
      fi
      echo "${ASSET_NAME} was already absent (an earlier run died mid-swap); continuing"
    else
      die "could not delete the live ${ASSET_NAME} from ${POINTER_TAG}, and could not confirm afterwards whether it is still there. Refusing to run the destructive fallback against an asset that may be working. The install URL is unchanged either way."
    fi
  fi
  # Past this point the live asset is provably gone: either the delete
  # succeeded, or a successful query reported it absent. That is what makes the
  # --clobber fallback below safe — there is nothing left for it to destroy.

  # --- 4d. close the window ------------------------------------------------
  SWAPPED=0
  if ID="$(asset_id "$INCOMING_NAME")"; then
    if [ -n "$ID" ] || [ "$DRY_RUN" = 1 ]; then
      if gh_retry "renaming ${INCOMING_NAME} to ${ASSET_NAME}" \
        gh api -X PATCH "repos/${REPO_SLUG}/releases/assets/${ID:-0}" -f "name=${ASSET_NAME}" --silent; then
        SWAPPED=1
      fi
    fi
  else
    echo "::warning::could not look up ${INCOMING_NAME}; falling back to a direct upload."
  fi
  # The rename reported failure — but the PATCH may have reached GitHub with
  # only its response lost, in which case ${ASSET_NAME} is already in place and
  # working. Running the `--clobber` fallback then DELETES that working asset
  # first. So ask, and only fall back on a confirmed absence.
  if [ "$SWAPPED" = 0 ]; then
    LIVE_STATE=0
    asset_state "$ASSET_NAME" || LIVE_STATE=$?
    case "$LIVE_STATE" in
      0)
        echo "::notice::renaming ${INCOMING_NAME} reported failure, but ${ASSET_NAME} is present — the request had been applied and only its response was lost. Not touching it."
        SWAPPED=1
        ;;
      2)
        die "could not rename ${INCOMING_NAME}, and could not determine whether ${ASSET_NAME} is present. Refusing to run the destructive fallback against an asset that may be working. Re-run this workflow."
        ;;
    esac
  fi
  if [ "$SWAPPED" = 0 ]; then
    echo "::warning::${ASSET_NAME} is confirmed absent and could not be renamed into place; re-uploading it under its live name instead. The install URL is 404 until this succeeds."
    if ! gh_retry "re-uploading ${ASSET_NAME}" \
      gh release upload "$POINTER_TAG" "$WORKDIR/$ASSET_NAME" --repo "$REPO_SLUG" --clobber; then
      # Same question one last time: the upload may have landed regardless.
      FINAL_STATE=0
      asset_state "$ASSET_NAME" || FINAL_STATE=$?
      case "$FINAL_STATE" in
        0) echo "::notice::the re-upload reported failure, but ${ASSET_NAME} is present — the request had been applied and only its response was lost." ;;
        *) die "${POINTER_TAG} has NO ${ASSET_NAME} asset right now (or its presence cannot be confirmed) and the documented install URL is returning 404. Re-run this workflow, or attach ${TARGET_TAG}'s ${ASSET_NAME} to the ${POINTER_TAG} release by hand, to restore it." ;;
      esac
    fi
  fi

  # Best-effort tidy-up; an orphaned `.incoming` serves nothing and the next
  # run clobbers it, so neither a failed lookup nor a failed delete may fail
  # the release here.
  if LEFTOVER="$(asset_id "$INCOMING_NAME")" && { [ -n "$LEFTOVER" ] || [ "$DRY_RUN" = 1 ]; }; then
    run gh release delete-asset "$POINTER_TAG" "$INCOMING_NAME" --repo "$REPO_SLUG" --yes || true
  fi
fi

# ---------------------------------------------------------------------------
# 5. Point the git tag at the commit TARGET_TAG refers to — NOT at the
#    checkout's HEAD, which is the triggering tag and may be an older commit
#    when this run converged onto a newer target. Done through the refs API so
#    it works regardless of the checkout's fetch depth.
#
#    Non-fatal: the tag is cosmetic (assets hang off the release, not the tag),
#    and the install URL is already correct by this point. Failing the release
#    here would turn a cosmetic mismatch into a red release for no gain.
# ---------------------------------------------------------------------------
TARGET_SHA=""
if REF="$(gh api "repos/${REPO_SLUG}/git/ref/tags/${TARGET_TAG}" --jq '.object.type + " " + .object.sha' 2>/dev/null)"; then
  REF_TYPE="${REF%% *}"
  TARGET_SHA="${REF##* }"
  if [ "$REF_TYPE" = "tag" ]; then
    # Annotated tag: dereference to the commit it wraps.
    TARGET_SHA="$(gh api "repos/${REPO_SLUG}/git/tags/${TARGET_SHA}" --jq '.object.sha' 2>/dev/null || echo "")"
  fi
fi
if [ -z "$TARGET_SHA" ]; then
  echo "::warning::could not resolve the commit behind ${TARGET_TAG}; leaving the ${POINTER_TAG} git tag where it is. The release and its asset are correct."
else
  if gh api "repos/${REPO_SLUG}/git/ref/tags/${POINTER_TAG}" >/dev/null 2>&1; then
    TAG_OK=0
    run gh api -X PATCH "repos/${REPO_SLUG}/git/refs/tags/${POINTER_TAG}" \
      -f "sha=${TARGET_SHA}" -F force=true --silent || TAG_OK=1
  else
    TAG_OK=0
    run gh api -X POST "repos/${REPO_SLUG}/git/refs" \
      -f "ref=refs/tags/${POINTER_TAG}" -f "sha=${TARGET_SHA}" --silent || TAG_OK=1
  fi
  # Same "it may have been applied and the response lost" question as the asset
  # calls. Nothing destructive hangs off the answer here — the tag is cosmetic
  # and the URL is already correct — but asking keeps the warning honest
  # instead of reporting a stale tag that is in fact correct.
  if [ "$TAG_OK" != 0 ] && [ "$DRY_RUN" != 1 ]; then
    if [ "$(gh api "repos/${REPO_SLUG}/git/ref/tags/${POINTER_TAG}" --jq '.object.sha' 2>/dev/null)" = "$TARGET_SHA" ]; then
      TAG_OK=0
      echo "::notice::the ${POINTER_TAG} tag update reported failure but the tag is at ${TARGET_SHA} — the request had been applied and only its response was lost."
    fi
  fi
  if [ "$TAG_OK" != 0 ]; then
    echo "::warning::could not point the ${POINTER_TAG} git tag at ${TARGET_SHA}. The release and its asset are correct; only the tag is stale."
  fi
fi

echo "${POINTER_TAG} now serves ${TARGET} (${TARGET_TAG}${TARGET_SHA:+ @ ${TARGET_SHA}})"
