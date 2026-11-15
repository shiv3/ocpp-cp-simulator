---
title: Documented charger presets
type: concept
summary: Sample blueprints modelled on a vendor's public OCPP documentation, shipped as files under docs/examples/blueprints/ and loaded with `--blueprint`; every value cites a document by SHA-256, page and evidence type, enforced by a test.
sources:
  - docs/examples/blueprints/abb-terra-ac-22kw-socket-fw1.6.6.json
  - docs/examples/blueprints/abb-terra-ac-22kw-socket-fw1.6.6.sources.json
  - apps/cli/src/server/blueprintFiles.ts
  - apps/cli/src/server/__tests__/blueprintExamples.test.ts
  - packages/contracts/src/methods.ts (blueprintSchema, blueprintSourceSchema)
  - "issue #331"
  - "issue #241"
related:
  - control-plane.md
  - ../entities/daemon.md
  - ../entities/cli.md
  - ../analyses/oecs-as-a-charger-model-source.md
  - fleet-templates.md
updated: 2026-11-15
---

# Documented charger presets

A **charger preset** is not a new concept: it is an ordinary
[blueprint](control-plane.md#blueprints) whose values are taken from a
charger vendor's **public** documentation, with a citation for every value.
Presets let a CSMS test suite run against charge points that report
realistic identity, connector count, power rating and — most usefully —
realistic _gaps_: an action the vendor does not implement is answered with
CALLERROR `NotImplemented` (OCPP-J 1.6 §4.2.3, through the
[capability profile](control-plane.md) of #618), and a `TriggerMessage` for a
target the vendor does not list is answered `NotImplemented` (OCPP 1.6
§5.17). A CSMS that only ever met a charge point implementing everything
never exercises those branches.

Presets are **sample files, not built-ins**. They live under
[`docs/examples/blueprints/`](../examples/blueprints/) and reach a daemon only
through [`--blueprint <file>`](../entities/daemon.md#starting-the-server); the five generic
built-ins (`ac-22kw` …) are unchanged. Keeping vendor-modelled data out of the
built-in catalogue keeps trademark, maintenance and accuracy risk in a
cited sample a user chooses to load, rather than in a product feature
(#331, #241).

## Using one

```sh
ocpp-cp-simulator --daemon \
  --blueprint docs/examples/blueprints/abb-terra-ac-22kw-socket-fw1.6.6.json
```

The preset then appears in `blueprint.list`, and
`cp.create_many { blueprintId: "abb-terra-ac-22kw-socket-fw1.6.6", wsUrl, count }`
or a [fleet template](fleet-templates.md) line instantiates it. Like every
`--blueprint` blueprint it is read-only: `blueprint.save` and
`blueprint.delete` refuse its id with `invalid_params`.

## Shipped presets

| File                                    | Modelled on                                                                                              | What it sets                                                                                                                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abb-terra-ac-22kw-socket-fw1.6.6.json` | ABB "Terra AC wallbox OCPP 1.6 Implementation Overview" v1.8 (FW 1.6.6) and the Terra AC wallbox leaflet | OCPP 1.6J; 1 connector; 22 000 W cap on connector 1; `ReserveNow` / `CancelReservation` disabled; `TriggerMessage` limited to BootNotification, DiagnosticsStatusNotification, FirmwareStatusNotification, Heartbeat, MeterValues, StatusNotification |

The ABB preset deliberately sets **no `vendor` / `model`**: the documents do
not state the `chargePointVendor` / `chargePointModel` strings the charger
sends in BootNotification, and a preset never guesses identity. The charge
point reports the simulator's defaults until a source for the strings exists.

Everything the documents say that a blueprint cannot express yet is listed in
the preset's `source.unmapped`, with page: the configuration-key defaults
(`HeartbeatInterval` 120, `MeterValueSampleInterval` 30, read-only
`GetConfigurationMaxKeys` 20, the reported `SupportedFeatureProfiles`, …),
the unsupported optional keys, the vendor keys, and behaviour such as
"`HeartbeatInterval` below 10 is accepted but executed as 10". Seeding
configuration keys from a blueprint is a separate, later change; until then
these values are recorded, not applied.

## Provenance: `source` and the sources file

A preset carries `schemaVersion: 1` and a `source` block
([`blueprintSourceSchema`](../../packages/contracts/src/methods.ts)):

| Field            | Meaning                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `format`         | `manual` (written by hand from public documents) or `oecs` (reserved for the importer discussed in #331)      |
| `citations`      | Repository-relative path of the per-value sources file                                                        |
| `documents[]`    | `id`, `title`, `publisher`, `uri`, `revision`, **`sha256`** of the retrieved bytes (mandatory), `retrievedAt` |
| `unmapped[]`     | `what` the document says that the blueprint does not express, `documentId`, `locator` (page / section)        |
| `mapperRevision` | Importer revision (`oecs` only)                                                                               |

The **SHA-256 is the document's identity**; the URL is only where it was
fetched and can change under it ([OECS analysis, decision 5](../analyses/oecs-as-a-charger-model-source.md#decisions-after-review)).
The documents themselves are never committed and never stored in a blueprint.

Beside each preset `X.json` sits `X.sources.json`:

```json
{
  "blueprint": "X.json",
  "values": [
    {
      "pointer": "/params/connectors",
      "documentId": "…",
      "documentSha256": "…",
      "locator": "p.10 §3.2.1 NumberOfConnectors",
      "evidence": "documented",
      "note": "Default 1, read-only."
    }
  ]
}
```

`pointer` is a JSON Pointer into the preset. A **value** is a scalar or an
array of scalars (a list such as `disabledActions` is one documented value).
`evidence` is one of:

| Evidence           | Meaning                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `documented`       | The document states the value                                                                                                |
| `derived`          | Computed mechanically from a documented value (22 kW → 22000 W); the formula goes in `note`                                  |
| `simulatorDefault` | The document is silent; the simulator's default is kept                                                                      |
| `assumption`       | A judgement the document does not make; only under `/params/capabilityProfile/` and `/params/behaviorParams/`, with a `note` |

[`blueprintExamples.test.ts`](../../apps/cli/src/server/__tests__/blueprintExamples.test.ts)
runs over every file in `docs/examples/blueprints/` and fails unless the preset
loads through `--blueprint`, every value has **exactly one** sources entry (and
no entry points at a value the preset does not set), each entry names a listed
document with its SHA-256, a locator and a known evidence type, and the
description carries the disclaimer below.

## Sourcing rules

1. Values come only from documents the **vendor itself publishes**: data
   sheets, OCPP implementation or configuration guides, the vendor's web
   pages, the vendor's own public repositories. Reseller pages, re-hosted
   copies, third-party captures and data from other software are not sources.
2. Every value has a sources entry; `vendor`, `model` and configuration values
   never rest on `assumption`.
3. A typo in the document is neither copied nor silently fixed: the value is
   normalized to the OCPP identifier and the `note` records the original
   spelling.
4. The document revision (firmware version) is part of the preset id, because
   values change between firmware releases.
5. When a document contradicts itself, the item is left out of the preset and
   recorded in `unmapped`; the preset does not pick a side.
6. The original documents are not committed (no redistribution right); the
   sources file holds locators and short summaries only.

## Naming and disclaimer

A preset's id is vendor + product + variant + document firmware
(`abb-terra-ac-22kw-socket-fw1.6.6`), its name says "modelled on public …
docs", and its description starts with "Modelled on public documentation of
&lt;vendor&gt;" followed by:

> Not affiliated with or endorsed by &lt;vendor&gt;. Built only from
> &lt;vendor&gt;'s public documentation listed in source; not a certified or
> complete model of the product. Product names are trademarks of their owners.

The `chargePointVendor` / `chargePointModel` strings, where a preset sets
them, are the factual data the device sends on the wire and are used
descriptively because a CSMS test needs exactly those strings. No logos,
product images or figures from the documents are used. A vendor's request to
remove its preset is honoured by deleting the file; the id is not reused.
