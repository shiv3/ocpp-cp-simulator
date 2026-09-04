#!/usr/bin/env bash
#
# Move the rolling `cli-latest` pointer onto a freshly published CLI release.
#
# Usage: scripts/roll-cli-latest.sh <version> <tag> <asset-path>
#   e.g. scripts/roll-cli-latest.sh 0.4.0 cli-v0.4.0 ocpp-cp-simulator.tgz
#
# Env:
#   GH_TOKEN   required by `gh` (the workflow passes ${{ secrets.GITHUB_TOKEN }})
#   REPO_SLUG  owner/name to act on (default: shiv3/ocpp-cp-simulator)
#   DRY_RUN=1  print the mutating commands instead of running them, so the
#              logic below can be exercised without a real release
#
# Why a pointer at all (#321): GitHub's `releases/latest` resolves across every
# tag train in the repo, and this one has two — `v*` (desktop) and `cli-v*`
# (CLI). Whenever the newest release is a desktop one, which is the case for
# roughly half of any release cycle, `releases/latest/download/*.tgz` 404s
# because desktop releases carry no tarball. `cli-latest` is scoped to the CLI
# train, so it is always right. It is kept a PRE-RELEASE deliberately: GitHub
# never resolves `releases/latest` to a pre-release, so the pointer cannot
# itself hijack the desktop train's "Latest" badge, while
# `releases/download/cli-latest/<asset>` keeps working normally.
#
# THIS SCRIPT IS A GUARD, SO EVERY FAILURE MODE IN IT MUST POINT THE SAFE WAY.
# A guard that fails open, aborts, or cancels the thing it protects is worse
# than no guard, because it is trusted. Specifically:
#
#   * The move only ever rolls FORWARD. It used to be an unconditional
#     `git push -f` + `gh release upload --clobber`, so re-running an older
#     tag's workflow, or two release jobs finishing out of order, would quietly
#     serve an older package under the URL the docs call the newest. The run
#     reads the version the pointer holds from a machine-readable marker in its
#     release body and refuses to go backwards. Re-running the SAME version is
#     allowed — that is how a failed upload is recovered.
#   * Looking up the pointer FAILS CLOSED. Only a confirmed HTTP 404 means
#     "does not exist yet"; any other lookup failure (auth, rate limit,
#     network, a 5xx) aborts the run rather than being read as "absent", which
#     would skip the rollback check entirely and force-move the tag.
#   * Versions are compared NUMERICALLY, field by field, not with `sort -V`.
#     `sort -V` is not SemVer: it orders `1.0.0-rc.1` AFTER `1.0.0`, so
#     re-running a prerelease after the stable release would pass the check and
#     roll the pointer backwards — the exact bug the check exists for.
#     Prerelease and build-metadata versions are refused outright instead, with
#     an error that says why; the CLI train has only ever cut `X.Y.Z` tags.
#   * A pointer release with no marker (hand-created, or from before the marker
#     existed) INITIALISES the marker instead of aborting. Under `set -o
#     pipefail` a `grep` that matches nothing fails the whole assignment, which
#     used to kill the script in exactly the migration case this has to
#     survive. It is a `::warning::`, not silence: the rollback check genuinely
#     cannot be applied that one time.
#   * The asset is uploaded BEFORE the marker is written and before the tag
#     moves. If a step fails midway, the marker still names the version the
#     pointer actually serves; the other order would leave the marker claiming
#     a version whose asset never landed, and the guard would then trust it.
#   * The workflow serialises only the job that runs this script, never the
#     job that publishes the per-tag `cli-v*` assets — see cli-release.yml.
set -euo pipefail

VERSION="${1:?usage: roll-cli-latest.sh <version> <tag> <asset-path>}"
TAG="${2:?usage: roll-cli-latest.sh <version> <tag> <asset-path>}"
ASSET="${3:?usage: roll-cli-latest.sh <version> <tag> <asset-path>}"
REPO_SLUG="${REPO_SLUG:-shiv3/ocpp-cp-simulator}"
DRY_RUN="${DRY_RUN:-0}"
POINTER_TAG="cli-latest"
MARKER_PREFIX="<!-- cli-latest-version:"

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

# ---------------------------------------------------------------------------
# Versions. Only plain `X.Y.Z` is accepted, so the numeric comparison below is
# total and exact over the whole accepted domain.
# ---------------------------------------------------------------------------
is_release_version() {
  case "$1" in
    *[!0-9.]* | .* | *. | *..*) return 1 ;;
  esac
  # exactly three numeric fields
  [ "$(printf '%s' "$1" | awk -F. '{print NF}')" = 3 ]
}

# 0 when $1 is strictly newer than $2.
version_gt() {
  awk -F. -v a="$1" -v b="$2" '
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
  die "refusing to move ${POINTER_TAG} to '${VERSION}': only plain X.Y.Z releases may own the rolling pointer. A SemVer prerelease or build-metadata version (1.0.0-rc.1, 1.0.0+build) cannot be ordered against a stable one by this script, and ordering it wrongly would roll the pointer backwards — which is the failure this guard exists to prevent. Publish it as a pinned cli-v* release only."
fi

# ---------------------------------------------------------------------------
# What does the pointer hold now? Fail CLOSED: only a confirmed 404 counts as
# "not created yet". `gh api` is used rather than `gh release view` because it
# reports the HTTP status verbatim, so a 404 can be told apart from a 401, a
# 403 rate limit, a 5xx or a DNS failure.
# ---------------------------------------------------------------------------
POINTER_EXISTS=0
BODY=""
if BODY="$(gh api "repos/${REPO_SLUG}/releases/tags/${POINTER_TAG}" --jq '.body // ""' 2>/tmp/roll-gh-err.$$)"; then
  POINTER_EXISTS=1
else
  GH_ERR="$(cat /tmp/roll-gh-err.$$ 2>/dev/null || true)"
  case "$GH_ERR" in
    *"HTTP 404"* | *"Not Found"*)
      echo "${POINTER_TAG} does not exist yet (HTTP 404); it will be created at ${VERSION}"
      ;;
    *)
      rm -f /tmp/roll-gh-err.$$
      die "could not read ${POINTER_TAG} and it was not a 404, so it is unknown whether the pointer already holds a newer release. Refusing to move it. Underlying error: ${GH_ERR}"
      ;;
  esac
fi
rm -f /tmp/roll-gh-err.$$

# ---------------------------------------------------------------------------
# The rollback check. `|| true` on the extraction: under `set -o pipefail` a
# grep that matches nothing fails the assignment and would abort the script
# before the "no marker yet" branch could run — which is precisely the state a
# hand-created pointer release is in.
# ---------------------------------------------------------------------------
CURRENT=""
if [ "$POINTER_EXISTS" = 1 ]; then
  CURRENT="$(printf '%s\n' "$BODY" \
    | grep -oE "$MARKER_PREFIX [^ ]+ -->" \
    | head -n 1 \
    | sed -E "s/^.*: (.+) -->$/\1/" || true)"
fi

if [ -n "$CURRENT" ]; then
  if ! is_release_version "$CURRENT"; then
    die "${POINTER_TAG}'s version marker reads '${CURRENT}', which is not a plain X.Y.Z version. Refusing to guess whether ${VERSION} is newer. Fix the marker on the ${POINTER_TAG} release, then re-run."
  fi
  if [ "$CURRENT" = "$VERSION" ]; then
    echo "${POINTER_TAG} already holds ${VERSION}; re-publishing the same version (this is how a failed upload is retried)"
  elif version_gt "$VERSION" "$CURRENT"; then
    echo "${POINTER_TAG} currently holds ${CURRENT}; rolling forward to ${VERSION}"
  else
    echo "::notice::${POINTER_TAG} already points at ${CURRENT}; refusing to roll it back to ${VERSION}"
    exit 0
  fi
elif [ "$POINTER_EXISTS" = 1 ]; then
  echo "::warning::${POINTER_TAG} exists but carries no version marker, so the roll-back check cannot be applied this once. Moving it to ${VERSION} and writing the marker; subsequent runs are guarded."
fi

NOTES="Rolling pointer to the newest CLI release (currently **${TAG}**).

\`\`\`sh
bun install -g https://github.com/${REPO_SLUG}/releases/download/${POINTER_TAG}/${ASSET##*/}
\`\`\`

Release notes and per-version tarballs live on the \`cli-v*\` releases.
Kept as a pre-release so it never becomes the repository's \"Latest\" release —
the desktop \`v*\` train owns that badge (#321).

${MARKER_PREFIX} ${VERSION} -->"

# Asset first, then the marker, then the tag: see the header. POINTER_EXISTS is
# the single lookup made above rather than a second `gh release view`, so the
# two cannot disagree between the check and the write.
if [ "$POINTER_EXISTS" = 1 ]; then
  run gh release upload "$POINTER_TAG" "$ASSET" --repo "$REPO_SLUG" --clobber
  run gh release edit "$POINTER_TAG" --repo "$REPO_SLUG" --prerelease \
    --title "CLI (rolling latest)" --notes "$NOTES"
else
  run gh release create "$POINTER_TAG" --repo "$REPO_SLUG" --prerelease \
    --title "CLI (rolling latest)" --notes "$NOTES" "$ASSET"
fi

# The git tag is not what makes the download URL work (assets hang off the
# release, not the tag), but leaving it on an old commit is misleading.
# `cli-latest` matches neither the `v*` nor the `cli-v*` push trigger, and in
# any case a push made with GITHUB_TOKEN does not start new workflow runs.
run git tag -f "$POINTER_TAG"
run git push -f origin "refs/tags/${POINTER_TAG}"

echo "${POINTER_TAG} now serves ${VERSION} (${TAG})"
