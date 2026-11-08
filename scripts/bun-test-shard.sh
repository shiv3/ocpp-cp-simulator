#!/usr/bin/env bash
# bun-test-shard.sh INDEX COUNT [BUN TEST ARGS...] -- runs one CI shard of the
# `test:bun` suite. The suite is every tracked *.bun.test.ts(x) file (what
# `bun test bun.test` matches); files are sorted and dealt round-robin, so a
# shard is the same set on every run and a new file lands in one shard only.
# --isolate, as in `test:bun`: each file gets a fresh global, so what one file
# leaves behind cannot slow down or break the next (#803).
set -euo pipefail
index="${1:?usage: bun-test-shard.sh INDEX COUNT [ARGS...]}"
count="${2:?usage: bun-test-shard.sh INDEX COUNT [ARGS...]}"
shift 2
mapfile -t files < <(git ls-files '*bun.test.ts' '*bun.test.tsx' | sort | awk -v n="$count" -v i="$index" '(NR - 1) % n == i { print "./" $0 }')
[ "${#files[@]}" -gt 0 ] || { echo "shard $index/$count has no files" >&2; exit 1; }
echo "shard $index/$count: ${#files[@]} files"
exec bun test --isolate "$@" "${files[@]}"
