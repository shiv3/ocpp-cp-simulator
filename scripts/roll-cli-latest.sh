#!/usr/bin/env bash
#
# Point `cli-latest` at the highest published CLI release.
#
# Usage: scripts/roll-cli-latest.sh <triggering-version> <triggering-tag>
#   e.g. scripts/roll-cli-latest.sh 0.4.0 cli-v0.4.0
#
# Env:
#   GH_TOKEN   required by `gh` (the workflow passes ${{ secrets.GITHUB_TOKEN }})
#   REPO_SLUG  owner/name to act on (default: shiv3/ocpp-cp-simulator)
#   DRY_RUN=1  print the mutating commands instead of running them
#
# ---------------------------------------------------------------------------
# THE CONTRACT
#
#   `cli-latest` always serves the highest published `cli-vX.Y.Z` release, and
#   never a lower one, whatever order the pointer jobs run in or fail in.
#
# Two carve-outs, deliberate and stated rather than accidental:
#   * A CLI release tagged with a SemVer prerelease or build-metadata suffix
#     (`cli-v1.0.0-rc.1`) is not eligible to own the pointer and is ignored
#     when picking the highest. Install those by their pinned URL.
#   * If the highest release is later deleted, the pointer follows the new
#     highest downwards. "Never a lower one" is relative to what is published,
#     and an unpublished release cannot be the thing the pointer serves. That
#     case emits a `::warning::`.
# ---------------------------------------------------------------------------
#
# WHY IT ROLLS TO THE HIGHEST PUBLISHED RELEASE RATHER THAN TO ITS OWN
#
# The obvious design — each run moves the pointer to the version that triggered
# it, refusing if a marker in the pointer's release body names something newer
# — fails two ways, and both were shipped before this rewrite:
#
#   1. The queue is not ordered by version. GitHub keeps exactly ONE pending
#      job per concurrency group and replaces it with the most recently queued
#      one; queue order is release-job completion order. So with 1.1 running,
#      1.3 pending and a slow rerun of 1.2 arriving, 1.2's job evicts 1.3's,
#      1.2 advances the pointer from 1.1, and the already-published 1.3 is
#      never served at all.
#   2. The marker is not trustworthy as an ordering authority. Upload and
#      marker-write are two API calls: if the upload lands and the write does
#      not, the URL immediately serves the new asset while the body still names
#      the old version — and a later older run then passes the comparison
#      against that stale marker and rolls the served bytes backwards.
#      Reversing the two calls only swaps which direction is wrong.
#
# Converging on the highest published release removes both, because it removes
# the two things that were being trusted. Queue order stops mattering: whatever
# job survives reaches the same state. A cancelled job costs nothing, because
# the next one to run reaches that same state. And a stale — or hand-edited —
# marker cannot authorise anything, because the decision is made against the
# published releases, not against the marker.
#
# The marker is kept, but only as a RECORD of what is served, for humans and
# for `gh release view cli-latest`. It is deliberately NOT used to short-
# circuit the upload: doing so would put it back on the trusted path, and a
# marker that over-claims (a hand edit) would then skip an upload that was
# actually needed. Re-uploading an identical 2 MB asset is the cheaper mistake.
#
# ---------------------------------------------------------------------------
# OTHER FAILURE DIRECTIONS
#
#   * Listing the releases FAILS CLOSED. There is no "assume empty" path: if
#     the list cannot be read, the highest release is unknown and the pointer
#     is left alone.
#   * The release list is eventually consistent, and a listing taken moments
#     after a release is published can omit it. The triggering release is known
#     to be published — its publish job finished, which is what queued this one
#     — so the listing is retried until it appears, and the triggering version
#     is then used as a floor regardless. Without that floor a lagging listing
#     could roll the pointer to an older release with no later job to correct
#     it, which would break the contract in the one case nothing else covers.
#   * The asset is taken from the target RELEASE, not from the workspace, so
#     the bytes the pointer serves are provably the bytes that release
#     published.
#   * Asset first, then the marker, then the tag. A partial failure can only
#     leave the marker naming something lower than the bytes, which is now
#     inert (nothing reads it to decide), and the next run rewrites both.
set -euo pipefail

VERSION="${1:?usage: roll-cli-latest.sh <triggering-version> <triggering-tag>}"
TAG="${2:?usage: roll-cli-latest.sh <triggering-version> <triggering-tag>}"
REPO_SLUG="${REPO_SLUG:-shiv3/ocpp-cp-simulator}"
DRY_RUN="${DRY_RUN:-0}"
POINTER_TAG="cli-latest"
ASSET_NAME="ocpp-cp-simulator.tgz"
MARKER_PREFIX="<!-- cli-latest-version:"
LIST_ATTEMPTS="${LIST_ATTEMPTS:-6}"
LIST_BACKOFF="${LIST_BACKOFF:-5}"

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

# Only plain X.Y.Z, so the numeric comparison below is total and exact over the
# whole accepted domain. `sort -V` is deliberately not used anywhere: it is not
# SemVer-aware and orders 1.0.0-rc.1 AFTER 1.0.0.
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
# Which release should the pointer serve? The highest published cli-vX.Y.Z,
# with the triggering version as a floor (see the eventual-consistency note in
# the header). Fails closed: a listing that cannot be read stops the run.
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
  # The triggering release is published by definition; if the listing does not
  # show it yet, it is stale.
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

TARGET_TAG="cli-v${TARGET}"
if [ "$TARGET" = "$VERSION" ]; then
  echo "highest published CLI release is ${TARGET_TAG} (the release that triggered this run)"
else
  echo "::notice::${TAG} triggered this run, but ${TARGET_TAG} is the highest published CLI release; pointing ${POINTER_TAG} at ${TARGET_TAG}"
fi

# ---------------------------------------------------------------------------
# What does the pointer say it serves? Informational only — it cannot veto the
# target, and a stale or hand-edited value therefore cannot authorise a
# rollback. Fails closed on anything but a confirmed 404 all the same, because
# the create-vs-edit branch below depends on the answer.
# ---------------------------------------------------------------------------
POINTER_EXISTS=0
BODY=""
if BODY="$(gh api "repos/${REPO_SLUG}/releases/tags/${POINTER_TAG}" --jq '.body // ""' 2>/tmp/roll-gh-err.$$)"; then
  POINTER_EXISTS=1
else
  GH_ERR="$(cat /tmp/roll-gh-err.$$ 2>/dev/null || true)"
  case "$GH_ERR" in
    *"HTTP 404"* | *"Not Found"*)
      echo "${POINTER_TAG} does not exist yet (HTTP 404); it will be created at ${TARGET}"
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
  # the assignment and kill the script — which is exactly the state a
  # hand-created pointer release is in.
  CURRENT="$(printf '%s\n' "$BODY" \
    | grep -oE "$MARKER_PREFIX [^ ]+ -->" \
    | head -n 1 \
    | sed -E "s/^.*: (.+) -->$/\1/" || true)"
fi

if [ -n "$CURRENT" ] && ! is_release_version "$CURRENT"; then
  echo "::warning::${POINTER_TAG}'s version marker reads '${CURRENT}', which is not a plain X.Y.Z version. It is a record, not an authority, so this does not block the move; overwriting it with ${TARGET}."
elif [ -n "$CURRENT" ] && version_gt "$CURRENT" "$TARGET"; then
  echo "::warning::${POINTER_TAG} records ${CURRENT}, which is higher than the highest published CLI release (${TARGET}). A release was probably deleted, or the marker was hand-edited. Following the published releases down to ${TARGET}, because that is what the contract is about."
elif [ -n "$CURRENT" ]; then
  echo "${POINTER_TAG} currently records ${CURRENT}; setting it to ${TARGET}"
elif [ "$POINTER_EXISTS" = 1 ]; then
  echo "::warning::${POINTER_TAG} exists but carries no version marker; writing one at ${TARGET}"
fi

# ---------------------------------------------------------------------------
# Take the asset from the target release itself.
# ---------------------------------------------------------------------------
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/roll-cli-latest.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT
run gh release download "$TARGET_TAG" --repo "$REPO_SLUG" \
  --pattern "$ASSET_NAME" --dir "$WORKDIR" --clobber
if [ "$DRY_RUN" = 1 ]; then
  printf 'dry-run placeholder\n' > "$WORKDIR/$ASSET_NAME"
fi
[ -s "$WORKDIR/$ASSET_NAME" ] \
  || die "${TARGET_TAG} does not carry a non-empty ${ASSET_NAME}; refusing to point ${POINTER_TAG} at a release whose asset cannot be served."

NOTES="Rolling pointer to the highest published CLI release (currently **${TARGET_TAG}**).

\`\`\`sh
bun install -g https://github.com/${REPO_SLUG}/releases/download/${POINTER_TAG}/${ASSET_NAME}
\`\`\`

Release notes and per-version tarballs live on the \`cli-v*\` releases.
Kept as a pre-release so it never becomes the repository's \"Latest\" release —
the desktop \`v*\` train owns that badge (#321).

${MARKER_PREFIX} ${TARGET} -->"

if [ "$POINTER_EXISTS" = 1 ]; then
  run gh release upload "$POINTER_TAG" "$WORKDIR/$ASSET_NAME" --repo "$REPO_SLUG" --clobber
  run gh release edit "$POINTER_TAG" --repo "$REPO_SLUG" --prerelease \
    --title "CLI (rolling latest)" --notes "$NOTES"
else
  run gh release create "$POINTER_TAG" --repo "$REPO_SLUG" --prerelease \
    --title "CLI (rolling latest)" --notes "$NOTES" "$WORKDIR/$ASSET_NAME"
fi

# The git tag is not what makes the download URL work (assets hang off the
# release, not the tag), but leaving it on an old commit is misleading.
# `cli-latest` matches neither the `v*` nor the `cli-v*` push trigger, and in
# any case a push made with GITHUB_TOKEN starts no new workflow runs.
run git tag -f "$POINTER_TAG"
run git push -f origin "refs/tags/${POINTER_TAG}"

echo "${POINTER_TAG} now serves ${TARGET} (${TARGET_TAG})"
