---
title: "Source: vendor/ocpp-schemas (OCA OCPP JSON schemas)"
type: source
summary: The official Open Charge Alliance message schemas for OCPP 1.6, 2.0.1 and 2.1, vendored verbatim from mobilityhouse/ocpp at a pinned commit; generated TypeScript types live in `src/ocpp/`.
sources:
  - vendor/ocpp-schemas/NOTICE
  - scripts/fetch-ocpp-schemas.sh
  - scripts/generate-ocpp.ts
related:
  - ../concepts/ocpp-versions-and-transports.md
updated: 2026-09-03
---

# Source: `vendor/ocpp-schemas/`

**What it is.** The official OCA OCPP message JSON Schemas for `v16`, `v201`
and `v21`, vendored **verbatim** from
https://github.com/mobilityhouse/ocpp at commit
`d6b003d9f3ab411994f67d428ea51a82991f49e0` (`ocpp/{v16,v201,v21}/schemas/`).

**Licensing / handling rules (from `NOTICE`).**

- OCPP and its schemas are © Open Charge Alliance; the 2.1 schemas are
  CC BY-ND 4.0. Files are redistributed unmodified with attribution — **never
  patch, reformat or "fix" them** (`.prettierignore` excludes the directory).
- Refresh only through `scripts/fetch-ocpp-schemas.sh` (override the pin with
  `MOBILITYHOUSE_REF=<sha>`), which rewrites `NOTICE` with the new commit.
- Generated TypeScript types / validators derived from them live under
  `src/ocpp/` (`scripts/generate-ocpp.ts`) and are this project's own work.

**Why it matters for the wiki.** This is the ground truth for message field
names and enums across the three JSON versions the simulator speaks
([OCPP versions & transports](../concepts/ocpp-versions-and-transports.md)).
Wiki pages should cite message names as they appear here.
