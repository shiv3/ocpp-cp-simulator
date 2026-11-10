---
title: OCPP trace format (v1.1)
type: concept
summary: Implementation-independent JSON/JSONL record for one OCPP message exchange — the contract between traffic producers (this simulator, via `--trace-output` or the log adapter) and analyzers (OCPP DebugKit).
sources:
  - packages/trace/src/logEntryToTrace.ts
  - apps/cli/src/trace/TraceWriter.ts
  - package.json (@open-ocpp-trace/core, @open-ocpp-trace/jsonl, @open-ocpp-trace/viewer-core, @open-ocpp-trace/viewer-react)
  - "issue #188"
  - "issue #886"
related:
  - ../entities/analyze.md
  - ../entities/ocpp-debugkit.md
  - log-format.md
  - scenario-format.md
  - ../entities/cli.md
updated: 2026-11-10
---

# OCPP Trace Format (v1.1)

A small, **implementation-independent** JSON/JSONL format for one OCPP message
exchange. It is intended as a shared contract between tools that _produce_ OCPP
traffic (this simulator) and tools that _analyze_ it (e.g.
[OCPP DebugKit](../entities/ocpp-debugkit.md)), without coupling
either side to the other's internal models — see
[issue #188](https://github.com/shiv3/ocpp-cp-simulator/issues/188).

This is a **proof of concept**: it defines and versions the record shape and
ships an adapter from the simulator's own logs. The simulator now writes trace
files at runtime via `--trace-output <path>` (see [CLI](../entities/cli.md)); the
[`analyze` subcommand](../entities/analyze.md) consumes it (the DebugKit
integration that was originally deferred).

## Status & scope

- **Version `1.1`** (`schemaVersion`).
- This iteration recognizes **OCPP-J (JSON/WebSocket)** frames. SOAP transport
  is a documented follow-up (the format already carries a `transport` field).
- The format is usable without this simulator or DebugKit; it is a plain JSON
  object per exchange (JSONL for a stream).

## Reference implementation

This page is the format's prose specification. The reference
implementation of its record model, JSONL reader and JSONL writer is the
[Open OCPP Trace SDK](https://github.com/open-ocpp-trace/sdk), whose README
links back here as the normative description of v1.1. Since
[#886](https://github.com/shiv3/ocpp-cp-simulator/issues/886) the simulator
uses it instead of its own copy:

- `@open-ocpp-trace/core` — the `TraceRecord` model (a union discriminated
  by `messageType`) and `SCHEMA_VERSION` (`"1.1"`), which every record the
  simulator produces carries;
- `@open-ocpp-trace/jsonl` — `serializeRecord` (writer) and `readRecords`
  (reader).

Both are pinned to exact versions (`0.1.0`) in the root `devDependencies`
and installed from GitHub Packages, which asks for a token even for a public
package (`bunfig.toml`; see [CONTRIBUTING.md](../../CONTRIBUTING.md)).
The CLI bundle and the web console inline them, so the published
`ocpp-cp-simulator` package does not depend on them.

The web console's Message Log shows the records it derives from its log
buffer in the [Open OCPP Trace viewer](https://github.com/open-ocpp-trace/viewer)
(`@open-ocpp-trace/viewer-core`, `@open-ocpp-trace/viewer-react`), vendored
as tarballs under `vendor/open-ocpp-trace/` until their first release
([Trace tab](../entities/web-console.md#trace-tab)).

What stays in this repository is simulator-specific: the log adapter
(`logEntryToTrace`, `TraceCorrelator`, [below](#producing-records)), the
`--trace-output` writer, and `analyze`'s per charge point / per connector
split and DebugKit glue ([analyze](../entities/analyze.md)).

## Versioning

- Additive optional fields bump the **minor** version.
- Consumers **MUST ignore unknown fields** (forward compatibility within a
  major version).
- Changing the meaning of an existing field, or removing one, is a new
  **major** version.
- A published version is immutable: any change that alters what a
  conformant implementation outputs is a new version, not an edit.
- Producer extensions MUST go in `meta`, never in undeclared top-level
  fields.
- Known v1.1 limitation: a frame that does not parse as an OCPP-J array
  cannot be represented as a record (`messageType` is required). How the shared
  format should carry fully-unparseable frames is an open question for the
  specification repo.

## Record shape

| Field           | Type                                           | Notes                                                                                                                                                                        |
| --------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | string                                         | Trace schema version, e.g. `"1.1"`.                                                                                                                                          |
| `timestamp`     | string (ISO-8601)                              | When the message was observed.                                                                                                                                               |
| `ocppVersion`   | string (optional)                              | OCPP protocol version, e.g. `"1.6"`, `"2.0.1"`.                                                                                                                              |
| `transport`     | `"json"` \| `"soap"`                           | Wire transport.                                                                                                                                                              |
| `chargePointId` | string (optional)                              | Charge-point identity.                                                                                                                                                       |
| `connectorId`   | number (optional)                              | Connector id when connector-scoped and known.                                                                                                                                |
| `direction`     | `"cp-to-csms"` \| `"csms-to-cp"`               | Relative to the CP/CSMS pair.                                                                                                                                                |
| `messageType`   | `"CALL"` \| `"CALLRESULT"` \| `"CALLERROR"`    | OCPP-J frame kind.                                                                                                                                                           |
| `messageId`     | string (optional)                              | Correlates a CALL with its CALLRESULT/CALLERROR.                                                                                                                             |
| `action`        | string (optional)                              | Derived, optional. On CALLRESULT/CALLERROR back-filled by id correlation; MUST equal the correlated CALL's action when that CALL is present.                                 |
| `payload`       | any (optional)                                 | The OCPP message body.                                                                                                                                                       |
| `raw`           | string (optional)                              | Verbatim frame text exactly as sent/received. The only lossless representation (byte-exact hashing/dedup; preserves frames whose shape or payload violates the OCPP schema). |
| `error`         | `{ code?, description?, details? }` (optional) | Populated for CALLERROR only.                                                                                                                                                |
| `meta`          | object (optional)                              | Transport/execution metadata and analysis-specific extensions.                                                                                                               |

## Example

```json
{
  "schemaVersion": "1.1",
  "timestamp": "2026-07-14T02:00:00.000Z",
  "ocppVersion": "1.6",
  "transport": "json",
  "chargePointId": "CP001",
  "direction": "cp-to-csms",
  "messageType": "CALL",
  "messageId": "abc-1",
  "action": "BootNotification",
  "payload": {
    "chargePointVendor": "Example",
    "chargePointModel": "Simulator"
  },
  "raw": "[2,\"abc-1\",\"BootNotification\",{\"chargePointVendor\":\"Example\",\"chargePointModel\":\"Simulator\"}]"
}
```

## Producing records

The adapter in [`packages/trace/src/`](../../packages/trace/src/) maps this simulator's JSONL log
lines (`--log-format json`, the `logs.get` RPC, or the browser log-viewer
download) into trace records:

```ts
import { logLinesToTrace } from "../../packages/trace/src/logEntryToTrace";

const records = logLinesToTrace(jsonlLogLines, { ocppVersion: "1.6" });
```

### Validation violations (`meta`)

When an OCPP 1.6J charge point finds an inbound CALL's payload schema-invalid (`inboundValidation` `warn` or `enforce`, [Inbound CALL validation](ocpp-versions-and-transports.md#inbound-call-validation-on-ocpp-j-16)), the CALL's record carries

```json
"meta": { "validation": { "mode": "warn", "errorCode": "PropertyConstraintViolation", "description": "Inbound Reset: …" } }
```

`errorCode` is the OCPP-J 1.6 code `enforce` answers (and `warn` would have). The key is a producer extension in `meta`, so the schema version does not change; consumers that ignore `meta` see a plain CALL. The charge point logs an `Inbound validation: {json}` line on the `WebSocket` channel right after the CALL's `Received:` line; `logLinesToTrace` merges it into the CALL's record, and the live `--trace-output` writer holds an inbound CALL record back until the next record or the end of the tick so the same `meta` is written with it.

`logLinesToTrace` drops non-wire log lines, emits the verbatim frame text in
the `raw` field, and back-fills each CALLRESULT/CALLERROR `action` from the
CALL that established its `messageId`. `logLineToTraceRecord` converts a single
line (returning `null` for non-wire lines). The record type is the SDK's
`TraceRecord` and the version string is its `SCHEMA_VERSION`
([Reference implementation](#reference-implementation)); the in-repo
`OcppTraceRecord.ts` and `OCPP_TRACE_SCHEMA_VERSION` are gone (#886).

The `--trace-output` writer, `analyze --from-daemon` and the web console's
Session analysis panel write each record with the SDK's `serializeRecord`,
one LF-terminated JSON line per record. It checks the record envelope only,
never `payload` or `raw`, so deliberately invalid OCPP is still traced as
sent: malformed OCPP-J frames from fault injection (#393) keep a
byte-identical `raw`, and an inbound CALL whose payload breaks the schema
keeps its `meta.validation` (#593). The `--trace-output` writer warns about
a record the SDK rejects and skips it, as it does on an I/O failure.

## JSON Schema

> The `$id` below is the stable identifier of the published v1.1 schema and
> is kept verbatim even though this page now lives at
> `docs/concepts/trace-format.md`; a published version is immutable.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/shiv3/ocpp-cp-simulator/docs/trace-format.md#v1.1",
  "title": "OcppTraceRecord",
  "type": "object",
  "required": [
    "schemaVersion",
    "timestamp",
    "transport",
    "direction",
    "messageType"
  ],
  "additionalProperties": true,
  "properties": {
    "schemaVersion": { "type": "string" },
    "timestamp": { "type": "string", "format": "date-time" },
    "ocppVersion": { "type": "string" },
    "transport": { "type": "string", "enum": ["json", "soap"] },
    "chargePointId": { "type": "string" },
    "connectorId": { "type": "integer", "minimum": 0 },
    "direction": { "type": "string", "enum": ["cp-to-csms", "csms-to-cp"] },
    "messageType": {
      "type": "string",
      "enum": ["CALL", "CALLRESULT", "CALLERROR"]
    },
    "messageId": { "type": "string" },
    "action": { "type": "string" },
    "payload": {},
    "raw": { "type": "string" },
    "error": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "code": { "type": "string" },
        "description": { "type": "string" },
        "details": {}
      }
    },
    "meta": { "type": "object" }
  },
  "allOf": [
    {
      "if": { "properties": { "messageType": { "const": "CALL" } } },
      "then": { "required": ["action"] }
    },
    {
      "if": { "properties": { "messageType": { "const": "CALLERROR" } } },
      "then": { "required": ["error"] },
      "else": { "properties": { "error": false } }
    }
  ]
}
```

The `additionalProperties: true` allows forward compatibility: consumers must
accept records from a later minor version, so the schema does not reject
unknown fields; producers must put extensions in `meta` instead, and the same
applies to the nested `error` object.

The `allOf` conditionals mirror what the adapter emits: a `CALL` always carries
an `action`, and `error` is present only on `CALLERROR`.

## Changelog

- **v1.1**: Added `raw` field (verbatim frame text), clarified `action` semantics (derived, optional), documented versioning rules.
- **v1.0**: Initial proof-of-concept.
