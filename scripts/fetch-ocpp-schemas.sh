#!/usr/bin/env bash
# Fetch the official OCA OCPP JSON schemas (v16/v201/v21), vendored VERBATIM, from
# the mobilityhouse/ocpp repo (which redistributes the OCA schemas). Pinned to a commit.
#   Override with: MOBILITYHOUSE_REF=<sha> bash scripts/fetch-ocpp-schemas.sh
set -euo pipefail
REF="${MOBILITYHOUSE_REF:-d6b003d9f3ab411994f67d428ea51a82991f49e0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/ocpp-schemas"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "Fetching mobilityhouse/ocpp @ $REF ..."
git clone --quiet --depth 1 --filter=blob:none --sparse https://github.com/mobilityhouse/ocpp "$TMP/ocpp"
( cd "$TMP/ocpp" && git fetch --quiet --depth 1 origin "$REF" && git checkout --quiet "$REF" \
  && git sparse-checkout set ocpp/v16/schemas ocpp/v201/schemas ocpp/v21/schemas )
for v in v16 v201 v21; do
  mkdir -p "$DEST/$v"; rm -f "$DEST/$v"/*.json
  cp "$TMP/ocpp/ocpp/$v/schemas/"*.json "$DEST/$v/"
  echo "  $v: $(ls "$DEST/$v"/*.json | wc -l | tr -d ' ') files"
done
cat > "$DEST/NOTICE" <<EOF
OCPP JSON Schemas — Attribution
================================
These JSON Schema files are the official Open Charge Alliance (OCA) OCPP message
schemas, vendored VERBATIM (unmodified) from the public repository:
  https://github.com/mobilityhouse/ocpp  @ commit $REF
under ocpp/{v16,v201,v21}/schemas/.

OCPP and its schemas are (c) Open Charge Alliance. The OCPP 2.1 schemas are licensed
Creative Commons Attribution-NoDerivatives 4.0 International (CC BY-ND 4.0). The files
here are redistributed unmodified, with attribution; they are NOT modified (no patches/
overrides applied). Generated TypeScript types/validators derived from them live under
src/ocpp/ and are this project's own work.
EOF
echo "Wrote $DEST/NOTICE"
