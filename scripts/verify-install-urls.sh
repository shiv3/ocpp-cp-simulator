#!/usr/bin/env bash
#
# Every install command the documentation advertises must actually work.
#
# Why this exists (#321): the documented quick-start URL used GitHub's
# `releases/latest/download/…`, which resolves across BOTH tag trains in this
# repo (`v*` desktop, `cli-v*` CLI). With a desktop release newest — the case
# for roughly half of any release cycle — it redirects to a release carrying no
# `.tgz` and the command 404s.
#
# The first version of this guard only asserted that the several places
# restating the command agreed with each other. That is not enough: three
# places agreeing on a broken URL is exactly the state this issue describes.
# So this fetches every URL the docs tell a reader to run, and fails if one
# does not resolve.
#
# What counts as "advertised": a line inside the docs that a reader can copy
# and paste — `pnpm|bun|npm install -g <url>`. Prose that merely *names* a URL
# (for example, describing the rolling pointer that a future release will
# create) is deliberately not checked, because it is not an instruction.
#
# It also asserts a few release-plumbing invariants that decide whether that
# URL keeps working: that cli-release.yml still advertises the rolling pointer,
# still moves it through scripts/roll-cli-latest.sh, and serialises only the
# pointer move rather than the whole workflow.
#
# Usage: scripts/verify-install-urls.sh
# Needs network access to github.com.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
rc=0

# ---------------------------------------------------------------------------
# 1. The banned form. Prose explaining why it was dropped (this comment
#    included) must stay greppable, so only advertised commands are matched.
# ---------------------------------------------------------------------------
if git grep -nE '(pnpm|bun|npm) install -g https://github\.com/[^ ]*/releases/latest/download' -- '*.md' .github; then
  echo "::error::'releases/latest' resolves across both tag trains and 404s for half of every release cycle (#321)"
  rc=1
fi

# ---------------------------------------------------------------------------
# 2. Every advertised release URL resolves.
# ---------------------------------------------------------------------------
URLS="$(git grep -hoE '(pnpm|bun|npm) install -g https://github\.com/[^ )]+' -- '*.md' \
  | grep -oE 'https://[^ )]+' \
  | sort -u)"

if [ -z "$URLS" ]; then
  echo "::error::no install command found in the documentation at all — did the quick start lose it?"
  exit 1
fi

for url in $URLS; do
  code=""
  for attempt in 1 2 3; do
    # -I follows the redirect to the signed asset host; only the final status
    # matters. A transient network blip should not fail the build, a 404 must.
    code="$(curl -sIL --max-time 30 -o /dev/null -w '%{http_code}' "$url" || echo 000)"
    [ "$code" = 200 ] && break
    [ "$code" = 404 ] && break
    sleep 3
  done
  if [ "$code" = 200 ]; then
    echo "  ok   $code  $url"
  else
    echo "  FAIL $code  $url"
    echo "::error::the documented install URL does not resolve ($code): $url"
    rc=1
  fi
done

# ---------------------------------------------------------------------------
# 3. The release workflow and the docs must not disagree about which pointer
#    is canonical. cli-release.yml's generated notes advertise the rolling
#    `cli-latest` URL; it is templated with ${{ github.repository }} and is
#    created by the run itself, so it cannot be fetched from here — assert it
#    is still there and still produced by the roll script.
# ---------------------------------------------------------------------------
grep -q 'releases/download/cli-latest/ocpp-cp-simulator.tgz' .github/workflows/cli-release.yml || {
  echo "::error file=.github/workflows/cli-release.yml::release notes no longer advertise the rolling cli-latest URL"
  rc=1
}
grep -qE '^ *\./scripts/roll-cli-latest\.sh' .github/workflows/cli-release.yml || {
  echo "::error file=.github/workflows/cli-release.yml::the rolling cli-latest pointer is no longer moved by scripts/roll-cli-latest.sh"
  rc=1
}

# ---------------------------------------------------------------------------
# 4. Where `concurrency:` may and may not appear in cli-release.yml.
#
#    GitHub cancels the PENDING run whenever a newer one enters a concurrency
#    group; `cancel-in-progress: false` protects only the run already
#    executing, not the queue behind it. A workflow-level (or publish-job)
#    group therefore cancels a queued CLI release outright, and that release
#    never publishes its own `cli-v*` assets — which ARE the release. Only the
#    pointer-move job may be serialised, where being superseded is harmless.
#
#    Top-level YAML keys sit at column 0, so `^concurrency:` is an exact test
#    for the workflow-level form.
# ---------------------------------------------------------------------------
if grep -nE '^concurrency:' .github/workflows/cli-release.yml; then
  echo "::error file=.github/workflows/cli-release.yml::workflow-level concurrency cancels queued CLI releases before they publish their cli-v* assets; serialise only the pointer-move job"
  rc=1
fi
grep -q 'group: cli-latest-pointer' .github/workflows/cli-release.yml || {
  echo "::error file=.github/workflows/cli-release.yml::the cli-latest pointer move is no longer serialised (concurrency group 'cli-latest-pointer')"
  rc=1
}

[ $rc -eq 0 ] && echo "==> every advertised install URL resolves"
exit $rc
