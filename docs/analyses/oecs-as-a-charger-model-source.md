---
title: OECS as a charger model source
type: analysis
summary: What the OECS charger-specification schema contains, which parts map onto today's blueprint, which have nowhere to land, and the decisions an import adapter (#331) would have to settle.
sources:
  - "issue #331"
  - "issue #297"
  - "issue #241"
  - https://github.com/ChargePi/oecs
  - src/protocol/methods.ts
  - src/utils/blueprints/index.ts
  - src/cp/domain/charge-point/ConfigurationStore.ts
related:
  - ../concepts/control-plane.md
  - fleet-load-and-observability-roadmap.md
  - ../sources/github-issues.md
updated: 2026-09-07
---

# OECS as a charger model source

[#331](https://github.com/shiv3/ocpp-cp-simulator/issues/331) proposes importing
[OECS](https://github.com/ChargePi/oecs) documents into
[blueprints](../concepts/control-plane.md#blueprints) instead of inventing a
simulator-specific charger-model interchange format. This page records what OECS
actually is, how much of it the current blueprint can absorb, and what the
proposal implies that is not yet in the codebase.

## What OECS is

**Open EV Charger Specification** — a vendor-neutral JSON Schema (draft
2020-12, MIT) describing one charger **model**: the machine-readable counterpart
of a manufacturer datasheet. Modules: `charger`, `manufacturer`, `hardware`,
`connector`, `software`, `payment`, `pricing`, `metadata`, `common`.

- Versions `1.0.0`, `1.1.0`, `1.1.1`, `2.0.0`, each in its own directory, plus a
  self-contained single-file bundle per version at
  `dist/<v>/oecs.<v>.schema.json`. `2.0.0` is a major bump: enums and
  cross-field validation for `model.level`/`type`, connector `currentType` and
  meter accuracy class, and typed unit-of-measure enums. A document declares its
  own `version` and validates against that version's schema.
- Only `version`, `manufacturer`, `model` and `hardware` are required — the
  smallest valid document is a manufacturer name, a model name and one
  connector.
- Three example documents ship with the schema: `minimal.json` (1.0.0),
  `ac-wallbox-full.json` (AC Level 2, 1 connector, 2.0.0) and
  `dc-fast-charger-full.json` (DC 150 kW, CCS2 + CHAdeMO, 2.0.0).
- The project is young: the repository was created 2026-07-10 and carries four
  tags (`v1.0.0` … `v2.0.0`), with commits landing the day this page was
  written.

**Two prospective document providers, not one.** EVSEDB ([#241](https://github.com/shiv3/ocpp-cp-simulator/issues/241))
is adopting OECS; ChargePi separately runs
[OECS Hub](https://github.com/ChargePi/oecs-hub) (`oecs-hub.chargepi.cc`), a
registry of submitted, reviewed charger specs with a gRPC/gRPC-Web API. Either
can be a source of documents; #331's point is that the simulator should depend
on the _format_, not on either service.

## The boundary the issue asks us to document

| Layer           | Owns                                                          | Lives in                                                                      |
| --------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **OECS**        | What a charger model _is_, as the manufacturer specifies it   | External document, imported once                                              |
| **Blueprint**   | The simulator's reusable hardware description                 | [`blueprintSchema`](../../src/protocol/methods.ts), `blueprints` SQLite table |
| **ChargePoint** | A running instance: identity, CSMS link, configuration, state | `cp.create` / `cp.create_many`                                                |

Scenarios stay the behaviour half and are untouched by this — see
[`src/utils/blueprints/README.md`](../../src/utils/blueprints/README.md).

## What maps onto today's blueprint

A blueprint today is `{ id, name, description?, params, evSettings?, scenarioTemplateId? }`
where `params` is the `cp.create` block minus `cpId`. That is a small target:

| OECS                                                    | Blueprint                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manufacturer.name`                                     | `params.vendor`                             | Direct                                                                                                                                                                                                                                                                                                                                                                                     |
| `model.name` (or `model.partNumber`)                    | `params.model`                              | Direct                                                                                                                                                                                                                                                                                                                                                                                     |
| `manufacturer.name` + `model.name`                      | `id`, `name`                                | Slugified id; the importer has to pick a scheme                                                                                                                                                                                                                                                                                                                                            |
| `hardware.connectors[].length`                          | `params.connectors`                         | Count only, and **not automatically the OCPP connector count**: multi-head hardware may expose alternative plugs on one power path, which the simulator's flat model would turn into impossible simultaneous transactions                                                                                                                                                                  |
| `software.protocols[name=OCPP].version` + `transport[]` | `params.ocppVersion`                        | `"1.6"` + `websocket/json` → `OCPP-1.6J`; `"1.6"` + `http/soap` → `OCPP-1.6S`; `"2.0.1"` → `OCPP-2.0.1`                                                                                                                                                                                                                                                                                    |
| `software.protocols[…].securityProfile`                 | _(nothing — deliberately)_                  | A **capability**, not a deployment choice. "Supports profile 3" is not "instantiate with profile 3", which needs credentials or certificates. OECS also allows name-only values (`"TLS with Client Certificates"`), so a leading-digit parse is wrong twice over; when in doubt omit the field, never fall back to `0` (which means "leave transport/auth as configured")                  |
| `software.firmware.currentVersion`                      | `params.bootNotification`                   | `firmwareVersion`. A catalogue's "current version" is a default, not model identity                                                                                                                                                                                                                                                                                                        |
| `hardware.meter.manufacturer` + `.model`                | `params.bootNotification`                   | `meterType`. OECS has no meter serial — that is instance identity, so `meterSerialNumber` must not be synthesized from model-level data                                                                                                                                                                                                                                                    |
| `hardware.electrical.output.maxPower`                   | _(charger-side cap — **not** `evSettings`)_ | This is the **charger's** rating; `evSettings.maxChargingPowerKw` is what the **EV accepts**. Mapping it there makes a 150 kW charger claim every car draws 150 kW, and `applyBlueprintDefaults` marks the connector `_evSettingsOverridden`, so the wrong value is then sticky against `ev_settings.apply_default`. It belongs in the charger-side field the first slice adds — see below |

Everything else in OECS — housing, IP/IK ratings, dimensions, protection,
certifications, payment, pricing, `metadata` — is correctly out of scope and can
be dropped, as the issue says.

**The connector count needs a stated rule, not just a caveat.** `params.connectors`
is a count, and `ChargePoint` creates one _independent_ connector per id in it —
each able to hold its own transaction. OECS `hardware.connectors[]` lists
**plugs**, and multi-head hardware routinely exposes two or three plugs on one
power path. Taking `.length` directly would let the simulator run simultaneous
transactions on plugs that physically cannot charge at once. So the importer must
either **group plugs by power path** and emit one OCPP connector per path, or
**reject the document with a diagnostic** naming the plugs it could not
disambiguate. Silently taking the larger number is the one option that is wrong,
because it produces a station that passes every test and models hardware that
does not exist. Whether OECS carries enough information to do the grouping — it
has no explicit power-path field today — is the question that decides which of
the two the first slice implements.

## The gap: OECS is richer than the blueprint

The import adapter itself is thin. The work #331 actually implies is a
**blueprint hardware extension**, because the most simulation-relevant OECS data
has nowhere to land:

- **Per-connector hardware.** `params.connectors` is an integer. `Connector`
  (`src/cp/domain/connector/Connector.ts`) models status, availability, error
  codes, meter values and EV state — it carries no connector type, no
  `currentType`, no phases, no rated current/voltage, no per-connector max
  power. So `Type2_Mennekes` vs `CCS2_Combo2`, and the DC example's asymmetric
  150 kW CCS2 / 62.5 kW CHAdeMO pair, cannot be represented at all.
- **Charger-side power cap.** The only power figure in a blueprint is
  `evSettings.maxChargingPowerKw`, which is the _EV's_ limit. The built-in
  catalogue currently sets it to the charger's rating (22 / 50 / 150 / 350) as a
  stand-in, which conflates two different limits. A faithful OECS import wants a
  charger-side field and would leave the EV side to the scenario.
- **`simultaneousChargingSupported` / `dynamicPowerSharing`.** OECS states both
  explicitly for multi-connector units. The simulator has no power-sharing model,
  so the values would only be recorded, not simulated.
- **Configuration defaults.** OECS carries `software.protocols[].configuration[]`
  and `software.configuration[]` as `{key, dataType, defaultValue, minValue,
maxValue, unit, readOnly, rebootRequired}`, which lines up with OCPP 1.6
  configuration keys. The simulator has a
  [`ConfigurationStore`](../../src/cp/domain/charge-point/ConfigurationStore.ts)
  seeded from `defaultConfiguration(cp)`, but neither `cp.create` nor a blueprint
  can override a key at creation time. Seeding it is the single highest-fidelity
  item here — a charge point that answers `GetConfiguration` with the modelled
  vendor's defaults — and also its own slice: the store has a **closed** key set
  and rejects unknown and read-only mutations, so seeding needs a dedicated
  initialization path rather than `applyChange`, a stated precedence (simulator
  defaults < model defaults < persisted operator overrides), and a decision about
  what an unknown vendor key does (today `ChangeConfiguration` answers
  `NotSupported`). OCPP 2.0.1 is not the same job: its component/variable device
  model is a separate adapter, not the 1.6 keys renamed.
- **`profiles[]` / `smartCharging`.** OCPP feature profiles (`Core`,
  `SmartCharging`, `Reservation`, …) are free strings in OECS, and the names
  match the `SupportedFeatureProfiles` configuration key the simulator already
  defines (`src/cp/domain/charge-point/Configuration.ts`, read-only array). So
  they land in _what the charge point reports_, via the same config-seeding path
  as the keys above. They do not land in behaviour: handlers are registered
  unconditionally, so a model that advertises no `Reservation` profile still
  answers `ReserveNow`. Gating handlers on the advertised profiles would be a
  separate change.
- **Provenance.** `blueprintSchema` has no `source`-shaped field, and Zod object
  parsing strips unknown keys, so an imported document's origin would be silently
  discarded today. The good news is that
  [`BlueprintRepository`](../../src/cp/domain/persistence/BlueprintRepository.ts)
  stores the definition as a JSON blob validated only at the control-plane
  boundary — adding fields needs a `blueprintSchema` change but **no SQLite
  migration**.

## Decisions, after review

Two independent design reviews (Fable and Codex/GPT-5.6-sol, both reading the
code) agreed on most of this. Their consensus is recorded as the position; where
they disagreed, both options are kept.

1. **Several OCPP versions in one document.** Never pick the highest — the AC
   example's 1.6 and 2.0.1 entries carry _different_ `profiles[]` and
   `configuration[]`, and 1.6 is the entry the simulator can use most of.
   Selection is an import-time argument covering version **and** transport.
   _Open:_ default to 1.6 when the argument is absent (Fable), or refuse an
   ambiguous document and list the candidates (Codex). Either way the importer
   must validate against the versions the simulator supports itself:
   `cpParamsBaseSchema.ocppVersion` is `STR_64K` and `parseOcppVersion` falls
   back to `OCPP-1.6J` for anything unrecognized, so a bad mapping quietly
   produces a 1.6J station.
2. **Charger power vs EV power.** Fix it now. Add a charger-side cap and take the
   ratings out of the built-ins' `evSettings`; two numbers compose under
   `min(EV limit, connector cap, charging profile)`, one number meaning two
   things composes not at all. A second reason: `applyBlueprintDefaults` pushes
   blueprint `evSettings` through `setEVSettings`, which marks every connector
   `_evSettingsOverridden` — the hardware half is asserting behaviour values as
   sticky overrides that then block later default propagation.
3. **A field exists only if some code path reads it.** `simultaneousChargingSupported`,
   `dynamicPowerSharing`, `meterAccuracyClass`, `bidirectional`,
   `isoPlugAndCharge` get no blueprint keys. They belong in provenance —
   specifically an `unmapped` list of JSON pointers the importer saw and ignored,
   which is what lets an agent answer "why doesn't this blueprint share power?".
   The alternative (store the datasheet faithfully) makes the blueprint a second,
   incomplete OECS vocabulary this project would then version forever.
4. **Where import runs.** A control-plane method — `blueprint.import_oecs
{ document, ocppVersion?, id?, overwrite? } → { id, warnings[] }` — with the
   pure mapping in a dependency-free module a CLI can wrap later. Both
   objections raised against this in the first draft of this page were wrong:
   Ajv's Draft 2020-12 build is already loaded in the daemon
   (`src/scenario/scenarioSchemaValidator.ts`), and `mcpToolSchemaParity` only
   constrains tools that have been curated — `blueprint.delete` has an RPC and no
   tool, and the suite is green. **The daemon must not fetch source URLs**: the
   caller passes the document.
5. **Provenance.** `source: { format, schemaVersion, documentSha256, uri?,
revision?, unmapped[] }` plus the mapping decisions (`mapper`,
   `mapperRevision`, `selectedProtocol`). The **hash is mandatory** — a URL is
   mutable and therefore not provenance, and OECS itself has no reliable document
   revision id. **What it hashes has to be pinned before the importer is
   written**, because the hash decides whether a same-id import overwrites:
   hash the **source bytes exactly as supplied**, not canonical JSON and not the
   normalized object. Hashing the bytes means two byte-identical documents agree
   and anything else differs — including a whitespace-only edit, which is the
   safe direction for an overwrite decision. Hashing after normalization would
   make a real source change invisible whenever it normalizes away, which is the
   one outcome provenance must not permit; hashing canonical JSON sits between
   the two and buys nothing, since the caller passes the document and the daemon
   never re-fetches it. `importedAt` is audit metadata, not reproducibility metadata:
   keep it out of generated ids and equality. Do **not** store the raw document
   inline — `blueprint.list` returns up to 1000 definitions and would become a
   catalogue dump.
6. **Re-import must not silently replace.** `blueprint.save` is
   `ON CONFLICT (id) DO UPDATE`, so importing the same id twice swaps the
   hardware under every script that instantiates by that id. The importer should
   refuse a same-id / different-hash write unless told to overwrite, and report
   both hashes. Default id: a slug of manufacturer + `partNumber ?? name` +
   selected OCPP version. Built-in ids are already safe — `blueprint.save`
   refuses them.
7. **Unmapped, not dropped.** Payment and pricing are out of scope _today_;
   `model.type` of `wireless` / `portable-evse` and `Other` connector types are
   warnings with a JSON pointer, not rejections.

### Where the reviews disagreed, and how it resolved

**How much hardware belongs in the first slice.** Codex first said none —
identity, selected protocol, provenance and diagnostics only, because a
per-connector block with no reader is a record pretending to be a description.
Fable said a minimal `hardware.connectors[]` **together with the reader that
makes it real**, because without it an imported AC wallbox and an imported DC
charger differ only in a connector count, which is the failure the issue exists
to prevent. Put to Codex directly with the code (`derivedInstantaneousPowerW`
is a `Math.min` over the EV limit and the schedule limit; Q4 already commits
this issue to a charger-side power field and its reader), **Codex conceded**:
its rule was "no hardware without a reader", not "no hardware", and given Q4 an
identity-only importer is an artificial boundary.

The agreed first slice:

- `schemaVersion` on the blueprint (first, as its own change — see the storage
  risks below);
- identity, selected OCPP version + transport, provenance with a mandatory
  SHA-256, machine-readable unmapped diagnostics;
- `hardware.connectors[].{connectorId, maxDeliveryPowerW}` — normalized to
  **watts** (OECS values are unit-bearing, `W | kW`), with the connector id
  assigned by a documented canonical ordering because OECS array order is not
  semantic;
- that cap carried through all three boundaries — blueprint JSON,
  `ChargePointInitOptions` + the `charge_points` table, the runtime `Connector`;
- **one** authoritative effective-limit calculation,
  `min(EV acceptance, connector delivery, active schedule)`, used by every
  consumer. This is more than one extra term in `derivedInstantaneousPowerW`,
  and the two readers **do not share the entry point the first draft named**:

  - **Reported power** — `MeterValueBuilder` calls
    `connector.scheduleConstraints()`, which resolves against its own instant
    and never goes through `currentScheduleLimitWatts()`.
  - **Delivered energy** — `MeterValueScheduler` calls
    `getScheduleLimitWatts()`, wired to `effectiveMeterCapWatts()`, which
    _does_ call `currentScheduleLimitWatts()`.

  So a cap added in `currentScheduleLimitWatts()` would narrow the register and
  leave the reported `Power.Active.Import` unbounded — the exact
  telemetry-contradicts-register failure this bullet exists to prevent, with the
  sign flipped. The one point both paths already pass through is the private
  **`Connector.resolveScheduleConstraints(now)`**, which both callers invoke
  directly; that is where the hardware cap belongs, and a test asserting the two
  readers agree under a cap is what keeps it there;

- the built-ins' ratings moved out of `evSettings.maxChargingPowerKw` in the
  same change as the cap, before the importer commit.

Deferred until a reader exists: connector `type`, `currentType`, `phases`,
voltage / current limits, configuration seeding, feature-profile reporting or
gating, the aggregate station cap, power sharing, bidirectional and
Plug & Charge flags. PR order: versioning → cap vertical slice (migration,
reader, built-in fix) → importer against the now-executable target; if #331 has
to be one PR, those are its ordered commits.

**Still open — connector `type`.** Fable keeps it (medium confidence) because
dropping it makes the import indistinguishable from `{ vendor, model,
connectors: 2 }`. Codex drops it to `unmapped`: the OCPP 2.0.1 base report is
generated from the flat configuration store with no connector-instance input, so
"a future `Connector.ConnectorType` reader" is the dead-field trap by name; add
`type` and bump the blueprint schema atomically when that projection exists.
With `maxDeliveryPowerW` in the slice the two examples are already distinct, so
the distinctness argument no longer carries `type` on its own. This is the
maintainer's call.

### Two storage risks neither the issue nor the first draft named

- **The blueprint has no `schemaVersion` and no extensibility contract.**
  `blueprintSchema` is a plain `z.object` (unknown keys stripped),
  `BlueprintRepository` strips again on read, and `save` writes the stripped
  object. The moment a `hardware` block exists, a blueprint written by a newer
  daemon and read by an older one — a shared `--state-db`, or JSON pasted into
  an older release — is silently downgraded to a generic charge point, with no
  error and no trace. Add `schemaVersion` and make a row that cannot be fully
  represented log rather than vanish, **before** any hardware extension.
  Adding it has to define how **existing rows** are read, and the failure mode is
  severe: `BlueprintRepository.safeParse` validates stored definitions with
  `blueprintSchema`, `list()` omits rows that fail, and `get()` returns `null` —
  so making `schemaVersion` a required field would make every blueprint written
  before it **disappear from the console with no error**. Either give it a
  default that a pre-versioned row satisfies, or parse version-aware and backfill
  on read. A pre-versioned row surviving a restart is the acceptance test for
  this change, and it belongs in the same commit as the field.
- **Blueprint → ChargePoint is a second materialization boundary.** Provenance
  needs no SQLite migration because it rides in the blueprint's JSON blob, but
  `charge_points` persists creation parameters as **explicit columns**
  (`connectors`, `vendor`, `model`, `ocpp_version`, …). Any new simulated
  hardware must be carried into `ChargePointInitOptions` and that table, or it
  disappears on daemon restart.

### Aggregate vs per-connector power

`hardware.electrical.output.maxPower` is the whole-unit ceiling; each connector
carries its own `maxPower`. The DC example is 150 kW aggregate against
150 + 62.5 kW outlets, reconcilable only through `dynamicPowerSharing: true`.
The simulator has no power-sharing model and `Connector` already documents that
a station-wide charging profile is not enforced across the sum of connectors, so
the honest outcome is: per-connector caps imported, the aggregate recorded as
unmapped, and a warning in the result. Do not clamp connectors to the aggregate;
do not sum them; state the limitation.

Two mapping details that follow: OECS declares connector array order **not**
semantically meaningful while the simulator's connectors are positional `1..N`,
so the importer needs a deterministic ordering rule written down (a re-import
after the source reorders the array would otherwise flip connector 1 from CCS2
to CHAdeMO). And `powerQuantity.unit` is `W | kW`, with units on currents and
voltages too — a mapping that reads `.value` without `.unit` is wrong by a
factor of 1000 on some real documents.

## Validation and licensing

OECS is MIT, so unlike [`vendor/ocpp-schemas/`](../../vendor/ocpp-schemas/)
(CC BY-ND, verbatim-only) the schema may be vendored and adapted — **provided the
copyright and permission notices travel with it.** MIT requires them in copies and
in substantial portions, so vendoring the bundles is a two-file step: the schema
files and OECS's own `LICENSE.md` beside them, with a `NOTICE` line naming the
upstream project and the commit vendored from. "Adapted" does not exempt an
adaptation; a normalization adapter derived from the schema carries the same
requirement. This is a licence obligation rather than a courtesy, and it is the
one step in this plan that cannot be deferred to a later PR. Vendor the
released bundles, resolve no remote `$ref`s, compile once, and dispatch on the
document's declared `version` — 2.0.0 tightened constraints, so a 1.0.0 document
is not guaranteed to pass 2.0.0, and 1.x should be a separate normalization
adapter rather than a web of conditionals. Validate strictly and fail the import
on schema errors: an invalid document is a bug in the source, and a lenient
importer teaches the provider nothing.

The three shipped examples cover the AC / DC / multi-connector fixtures #331's
acceptance criteria ask for — but all three of those are 2.0.0 (the only 1.x
example is `minimal.json`), so a 1.x mapping path is untested unless someone
authors a fixture for it.

## If it proceeds

Files a first implementation would touch: a mapping module plus fixtures;
`src/protocol/methods.ts` (blueprint `schemaVersion` + provenance, and
`blueprint.import_oecs`); `src/cli/server/mcp/tools.ts` if the method gets a
curated tool — optional, since `call_method` already reaches it, but worth it
for a method agents will actually use, and adding one means adding it to the
parity test's `oneToOneCases`; `src/utils/blueprints/index.ts` if the built-ins
gain the charger-side power field; `src/cli/main.ts` for an offline wrapper.
Wiki: the method table in [Control plane](../concepts/control-plane.md), the flag
table in [CLI](../entities/cli.md), and this page for the OECS ↔ blueprint ↔
ChargePoint boundary the acceptance criteria ask to be documented.
