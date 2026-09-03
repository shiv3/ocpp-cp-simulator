---
title: "Source: schema/scenario.schema.json"
type: source
summary: The published JSON Schema (Draft 2020-12) for scenario files v1.1 — strict on known fields, permissive on unknown keys, advisory at load time; mirrors `ScenarioTypes.ts`.
sources:
  - schema/scenario.schema.json
related:
  - ../concepts/scenario-format.md
  - ../entities/scenario-templates.md
  - example-scenarios.md
updated: 2026-09-03
---

# Source: `schema/scenario.schema.json`

**What it is.** The machine-readable contract for the
[scenario file format](../concepts/scenario-format.md), shipped in the npm
package (`package.json` → `files` includes `schema`). Its `$comment` states the
design: "STRICT on known fields (types, required-ness, closed-vocabulary
enums) but PERMISSIVE on unknown keys at every object level
(`additionalProperties: true`)", because real editor exports carry xyflow UI
fields the schema deliberately does not reject.

**Key facts.**

- Version `1.1` (issue #214 introduced 1.0; issue #240 added the
  `connectionTrigger` node and the `csmsCallTrigger` `payload` condition).
- Mirrors `src/cp/application/scenario/ScenarioTypes.ts`; the closed
  vocabularies (node `type`, `OCPPStatus`, …) are enumerated here.
- Validation is **advisory**: the simulator warns on mismatch but never
  refuses to load — except that the `required` top-level fields (`id`,
  `name`, `targetType`, `nodes`, `edges`) are a hard gate at the control-plane
  boundary ([Control plane](../concepts/control-plane.md#cp-command-methods)).
- The per-action `responseOverride` status matrix is intentionally **not**
  encoded (called out in a `$comment`).
- `src/scenario/__tests__/scenarioSchema.conformance.test.ts` validates every
  bundled template and every `docs/examples/scenarios/*.json` against it.

**How to use it.** `validateScenarioSchema()` from
`src/scenario/scenarioSchemaValidator.ts`, or any Draft 2020-12 validator.
