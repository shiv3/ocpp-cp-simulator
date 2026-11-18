---
title: "Source: packages/ocpp/vendor/ocpp-schemas (OCA OCPP JSON schemas)"
type: source
summary: The official Open Charge Alliance message schemas for OCPP 1.6, 2.0.1 and 2.1, vendored verbatim from juherr/awesome-ev-charging at a pinned commit; generated TypeScript types live in `packages/ocpp/src/`.
sources:
  - packages/ocpp/vendor/ocpp-schemas/NOTICE
  - scripts/fetch-ocpp-schemas.sh
  - scripts/generate-ocpp.ts
  - apps/cli/src/server/mcp/schemaResources.ts
  - packages/core/src/cp/infrastructure/transport/codec/__tests__/vendoredOcaSchemas.test.ts
related:
  - ../concepts/ocpp-versions-and-transports.md
  - ../entities/mcp-endpoint.md
updated: 2026-11-15
---

# Source: `packages/ocpp/vendor/ocpp-schemas/`

**What it is.** The official OCA OCPP message JSON Schemas for `v16`, `v201`
and `v21`, vendored **verbatim** from
https://github.com/juherr/awesome-ev-charging at commit
`24fed58f64ec71fddd3e61f0300af13598b7d7c8`, which keeps the OCA downloads
byte for byte, line endings included (#1064):

| Directory | Source folder                                                                                     | Files |
| --------- | ------------------------------------------------------------------------------------------------- | ----- |
| `v16`     | `ocpp/OCPP-1.6/schemas/json/` (OCA download of 2025-04)                                           | 56    |
|           | `ocpp/Whitepapers/OCPP-1.6-security-whitepaper-edition-4/schema/` (Security Whitepaper edition 4) | 22    |
| `v201`    | `ocpp/OCPP-2.0.1/OCPP-2.0.1_part3_JSON_schemas/` (part 3, 2020-03-31, shipped with Edition 4)     | 128   |
| `v21`     | `ocpp/OCPP-2.1/OCPP-2.1_part3_JSON_schemas/` (part 3, 2025-01-23, shipped with Edition 2)         | 181   |

The `README.md` beside each source folder names the OCA file it comes from and
its SHA-256. The 1.6 core files keep OCA's CRLF line endings, except
`StopTransaction.json` (LF), the only one OCA reissued in 2025-04: its unit
enumeration adds `Celsius` beside the `Celcius` typo.

**Licensing / handling rules (from `NOTICE`).**

- OCPP and its schemas are © Open Charge Alliance; the 1.6, 2.0.1 and 2.1
  schemas are CC BY-ND 4.0 (<https://creativecommons.org/licenses/by-nd/4.0/>).
  Files are redistributed unmodified with attribution — **never patch,
  reformat or "fix" them** (`.prettierignore` excludes the directory).
- Refresh only through `bun run fetch:ocpp` (`scripts/fetch-ocpp-schemas.sh`;
  override the pin with `OCPP_SCHEMAS_REF=<sha>`), which rewrites `NOTICE` with
  the new commit, then `bun run gen:ocpp`.
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

## Before #1064: the mobilityhouse copy

Until #1064 the files came from `mobilityhouse/ocpp@d6b003d9`, which is not
verbatim: it strips `id` / `$id`, reindents every 1.6 core and 2.0.1 file, and
patches three schemas (its `Celsius` patch on `StopTransaction` is the one
OCA made itself in 2025-04). Switching to the OCA originals changed validation
in three places, pinned by
[`vendoredOcaSchemas.test.ts`](../../packages/core/src/cp/infrastructure/transport/codec/__tests__/vendoredOcaSchemas.test.ts):

| Schema                                | mobilityhouse                                 | OCA (now)     | Spec                                                                                 |
| ------------------------------------- | --------------------------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| 1.6 `MeterValues`                     | unit `Hertz`                                  | no `Hertz`    | 1.6 edition 2 §7.31: 1.6 has no UnitOfMeasure for frequency; `Frequency` is in Hertz |
| 1.6 `MeterValues`                     | `minItems: 1` on `meterValue`, `sampledValue` | no `minItems` | `1..*` on both; the 1.6-J sender drops an empty sample itself instead (#1064)        |
| 2.0.1 `Get15118EVCertificateResponse` | `exiResponse` up to 7500                      | up to 5600    | 2.0.1 Edition 4 part 2: `exiResponse string[0..5600]`                                |
