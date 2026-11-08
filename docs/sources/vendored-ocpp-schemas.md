---
title: "Source: packages/ocpp/vendor/ocpp-schemas (OCA OCPP JSON schemas)"
type: source
summary: The official Open Charge Alliance message schemas for OCPP 1.6, 2.0.1 and 2.1, vendored verbatim from mobilityhouse/ocpp at a pinned commit; generated TypeScript types live in `packages/ocpp/src/`.
sources:
  - packages/ocpp/vendor/ocpp-schemas/NOTICE
  - scripts/fetch-ocpp-schemas.sh
  - scripts/generate-ocpp.ts
  - apps/cli/src/server/mcp/schemaResources.ts
related:
  - ../concepts/ocpp-versions-and-transports.md
  - ../entities/mcp-endpoint.md
updated: 2026-11-08
---

# Source: `packages/ocpp/vendor/ocpp-schemas/`

**What it is.** The official OCA OCPP message JSON Schemas for `v16`, `v201`
and `v21`, vendored **verbatim** from
https://github.com/mobilityhouse/ocpp at commit
`d6b003d9f3ab411994f67d428ea51a82991f49e0` (`ocpp/{v16,v201,v21}/schemas/`).

**Licensing / handling rules (from `NOTICE`).**

- OCPP and its schemas are © Open Charge Alliance; the 1.6, 2.0.1 and 2.1
  schemas are CC BY-ND 4.0 (<https://creativecommons.org/licenses/by-nd/4.0/>).
  Files are redistributed unmodified with attribution — **never patch,
  reformat or "fix" them** (`.prettierignore` excludes the directory).
- Refresh only through `scripts/fetch-ocpp-schemas.sh` (override the pin with
  `MOBILITYHOUSE_REF=<sha>`), which rewrites `NOTICE` with the new commit.
- Generated TypeScript types / validators derived from them live under
  `packages/ocpp/src/` (`scripts/generate-ocpp.ts`) and are this project's own work.
- The MCP endpoint redistributes the files unmodified as resources: `scripts/generate-ocpp.ts`
  also writes their raw text (and the `NOTICE`) to the generated
  `packages/ocpp/src/schemaSources.ts`, which [MCP endpoint → OCPP schema
  resources](../entities/mcp-endpoint.md#ocpp-schema-resources) serves byte for byte, with the
  license link in every resource description (#613).

**Why it matters for the wiki.** This is the ground truth for message field
names and enums across the three JSON versions the simulator speaks
([OCPP versions & transports](../concepts/ocpp-versions-and-transports.md)).
Wiki pages should cite message names as they appear here.
