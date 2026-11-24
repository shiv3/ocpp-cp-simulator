#!/usr/bin/env bash
# Downloads a pinned k6 release (linux-amd64) into a directory and verifies it
# against the release's own checksums file, which is itself pinned by hash
# (#1126). Prints the path of the k6 binary.
#
#   scripts/verify/k6/install-k6.sh <dir>
#
# Bump K6_VERSION and K6_CHECKSUMS_SHA256 together: the second is
# `sha256sum k6-<version>-checksums.txt` of the release.
set -euo pipefail

K6_VERSION="${K6_VERSION:-v2.4.0}"
K6_CHECKSUMS_SHA256="${K6_CHECKSUMS_SHA256:-a8233db9f0e647d1c15d1ba6506d10445d6bd2aff0c40796cfb8c4d7e6ffee5a}"

dir="${1:?usage: install-k6.sh <dir>}"
mkdir -p "$dir"
cd "$dir"

base="https://github.com/grafana/k6/releases/download/${K6_VERSION}"
archive="k6-${K6_VERSION}-linux-amd64.tar.gz"
checksums="k6-${K6_VERSION}-checksums.txt"

curl -fsSL --retry 3 -o "$checksums" "${base}/${checksums}"
echo "${K6_CHECKSUMS_SHA256}  ${checksums}" | sha256sum --check --status \
  || { echo "checksums file does not match the pinned hash" >&2; exit 1; }
curl -fsSL --retry 3 -o "$archive" "${base}/${archive}"
grep " ${archive}\$" "$checksums" | sha256sum --check --status \
  || { echo "${archive} does not match ${checksums}" >&2; exit 1; }
tar -xzf "$archive" --strip-components=1 "k6-${K6_VERSION}-linux-amd64/k6"
chmod +x k6
echo "$PWD/k6"
