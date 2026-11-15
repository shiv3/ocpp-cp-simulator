#!/usr/bin/env bash
# Fetch the official OCA OCPP JSON schemas (v16/v201/v21), vendored VERBATIM, from
# the juherr/awesome-ev-charging repo (which keeps the OCA distributions as
# published). Pinned to a commit.
#   Override with: OCPP_SCHEMAS_REF=<sha> bash scripts/fetch-ocpp-schemas.sh
set -euo pipefail
REPO="https://github.com/juherr/awesome-ev-charging"
REF="${OCPP_SCHEMAS_REF:-97dc09851c82de14d6a953c3d163f8c79954aeab}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/packages/ocpp/vendor/ocpp-schemas"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# <destination> <source folder in the repo>; OCPP 1.6 takes the core schemas and
# the Security Whitepaper (edition 3) schemas.
SOURCES="v16 ocpp/OCPP-1.6/schemas/json
v16 ocpp/Whitepapers/OCPP-1.6-security-whitepaper-edition-3-2/schema
v201 ocpp/OCPP-2.0.1/OCPP-2.0.1_part3_JSON_schemas
v21 ocpp/OCPP-2.1/OCPP-2.1_part3_JSON_schemas"

echo "Fetching juherr/awesome-ev-charging @ $REF ..."
git clone --quiet --depth 1 --filter=blob:none --sparse "$REPO" "$TMP/aec"
( cd "$TMP/aec" && git fetch --quiet --depth 1 origin "$REF" && git checkout --quiet "$REF" \
  && git sparse-checkout set $(echo "$SOURCES" | cut -d' ' -f2) )
for v in v16 v201 v21; do mkdir -p "$DEST/$v"; rm -f "$DEST/$v"/*.json; done
while read -r v src; do
  for f in "$TMP/aec/$src"/*.json; do
    if [ -e "$DEST/$v/$(basename "$f")" ]; then
      echo "Duplicate schema $v/$(basename "$f") (from $src)" >&2; exit 1
    fi
    cp "$f" "$DEST/$v/"
  done
done <<EOF
$SOURCES
EOF
for v in v16 v201 v21; do
  echo "  $v: $(ls "$DEST/$v"/*.json | wc -l | tr -d ' ') files"
done
cat > "$DEST/NOTICE" <<EOF
OCPP JSON Schemas — Attribution
================================
These JSON Schema files are the official Open Charge Alliance (OCA) OCPP message
schemas, vendored VERBATIM (unmodified) from the public repository:
  $REPO  @ commit $REF
which keeps the OCA distributions as published:
  v16  <- ocpp/OCPP-1.6/schemas/json/ (OCPP 1.6 JSON schemas; the loose
          files of OCPP-1.6-JSON-Schemas.zip, line endings CRLF -> LF)
       +  ocpp/Whitepapers/OCPP-1.6-security-whitepaper-edition-3-2/schema/
          (OCPP 1.6 Security Whitepaper edition 3)
  v201 <- ocpp/OCPP-2.0.1/OCPP-2.0.1_part3_JSON_schemas/ (OCPP 2.0.1 part 3)
  v21  <- ocpp/OCPP-2.1/OCPP-2.1_part3_JSON_schemas/ (OCPP 2.1 part 3)

OCPP and its schemas are (c) Open Charge Alliance. The OCPP JSON Schemas (1.6,
2.0.1 and 2.1) are licensed Creative Commons Attribution-NoDerivatives 4.0
International (CC BY-ND 4.0): https://creativecommons.org/licenses/by-nd/4.0/
The files here are redistributed unmodified, with attribution; they are NOT
modified (no patches/overrides applied). Generated TypeScript types/validators
derived from them live under packages/ocpp/src/ and are this project's own work.
EOF
echo "Wrote $DEST/NOTICE"
