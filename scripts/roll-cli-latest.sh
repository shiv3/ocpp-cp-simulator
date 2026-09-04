#!/usr/bin/env bash
#
# Move the rolling `cli-latest` pointer onto a freshly published CLI release.
#
# Usage: scripts/roll-cli-latest.sh <version> <tag> <asset-path>
#   e.g. scripts/roll-cli-latest.sh 0.4.0 cli-v0.4.0 ocpp-cp-simulator.tgz
#
# Env:
#   GH_TOKEN   required by `gh` (the workflow passes ${{ secrets.GITHUB_TOKEN }})
#   REPO_SLUG  owner/name used in the notes body (default: shiv3/ocpp-cp-simulator)
#   DRY_RUN=1  print the mutating commands instead of running them, so the
#              roll-forward logic below can be exercised without a real release
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
# Why the version comparison: the move used to be an unconditional `git push
# -f` + `gh release upload --clobber`. Re-running an older tag's workflow — or
# two release jobs finishing out of order — would then quietly roll the pointer
# BACKWARDS and start serving an older package under the URL the docs call the
# newest. So the pointer only ever moves forward: the run reads the version the
# pointer currently holds out of a machine-readable marker in its release body
# and refuses to move if that is newer. Re-running the SAME version is allowed
# (it re-uploads an identical build, which is how you recover a failed upload).
# The workflow additionally serialises these runs with a `concurrency:` group,
# because the read-then-write below is not atomic on its own.
set -euo pipefail

VERSION="${1:?usage: roll-cli-latest.sh <version> <tag> <asset-path>}"
TAG="${2:?usage: roll-cli-latest.sh <version> <tag> <asset-path>}"
ASSET="${3:?usage: roll-cli-latest.sh <version> <tag> <asset-path>}"
REPO_SLUG="${REPO_SLUG:-shiv3/ocpp-cp-simulator}"
DRY_RUN="${DRY_RUN:-0}"

run() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "DRY_RUN: $*"
  else
    "$@"
  fi
}

# The marker the previous run left in the rolling release's body. Parsed, not
# guessed: the release title and the human prose around it can be edited by a
# maintainer without breaking the comparison.
MARKER_PREFIX="<!-- cli-latest-version:"
CURRENT=""
if BODY="$(gh release view cli-latest --repo "$REPO_SLUG" --json body -q .body 2>/dev/null)"; then
  CURRENT="$(printf '%s\n' "$BODY" \
    | grep -oE "$MARKER_PREFIX [^ ]+ -->" \
    | head -n 1 \
    | sed -E "s/^.*: (.+) -->$/\1/")"
fi

if [ -n "$CURRENT" ]; then
  NEWEST="$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | tail -n 1)"
  if [ "$NEWEST" != "$VERSION" ]; then
    echo "::notice::cli-latest already points at ${CURRENT}; refusing to roll it back to ${VERSION}"
    exit 0
  fi
  echo "cli-latest currently holds ${CURRENT}; rolling forward to ${VERSION}"
else
  echo "cli-latest holds no version marker yet; creating the pointer at ${VERSION}"
fi

NOTES="Rolling pointer to the newest CLI release (currently **${TAG}**).

\`\`\`sh
bun install -g https://github.com/${REPO_SLUG}/releases/download/cli-latest/${ASSET##*/}
\`\`\`

Release notes and per-version tarballs live on the \`cli-v*\` releases.
Kept as a pre-release so it never becomes the repository's \"Latest\" release —
the desktop \`v*\` train owns that badge (#321).

${MARKER_PREFIX} ${VERSION} -->"

# Move the git tag too. It is not what makes the download URL work (assets hang
# off the release, not the tag), but leaving it on an old commit is misleading.
# `cli-latest` matches neither the `v*` nor the `cli-v*` push trigger, and in
# any case a push made with GITHUB_TOKEN does not start new workflow runs.
run git tag -f cli-latest
run git push -f origin refs/tags/cli-latest

if gh release view cli-latest --repo "$REPO_SLUG" >/dev/null 2>&1; then
  run gh release edit cli-latest --repo "$REPO_SLUG" --prerelease \
    --title "CLI (rolling latest)" --notes "$NOTES"
  run gh release upload cli-latest "$ASSET" --repo "$REPO_SLUG" --clobber
else
  run gh release create cli-latest --repo "$REPO_SLUG" --prerelease \
    --title "CLI (rolling latest)" --notes "$NOTES" "$ASSET"
fi

echo "cli-latest now serves ${VERSION} (${TAG})"
