# OCPP Trace Format (v1.1)

A small, **implementation-independent** JSON/JSONL format for one OCPP message
exchange. It is intended as a shared contract between tools that _produce_ OCPP
traffic (this simulator) and tools that _analyze_ it (e.g.
[OCPP DebugKit](https://github.com/ocpp-debugkit/toolkit)), without coupling
either side to the other's internal models — see
[issue #188](https://github.com/shiv3/ocpp-cp-simulator/issues/188).

This is a **proof of concept**: it defines and versions the record shape and
ships an adapter from the simulator's own logs. The simulator now writes trace
files at runtime via `--trace-output <path>` (see [cli.md](./cli.md)); an
`analyze` subcommand and any DebugKit integration remain deliberately later
steps.

## Status & scope

- **Version `1.1`** (`schemaVersion`).
- This iteration recognizes **OCPP-J (JSON/WebSocket)** frames. SOAP transport
  is a documented follow-up (the format already carries a `transport` field).
- The format is usable without this simulator or DebugKit; it is a plain JSON
  object per exchange (JSONL for a stream).

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

The adapter in [`src/trace/`](../../src/trace/) maps this simulator's JSONL log
lines (`--log-format json`, the `logs.get` RPC, or the browser log-viewer
download) into trace records:

```ts
import { logLinesToTrace } from "../src/trace/logEntryToTrace";

const records = logLinesToTrace(jsonlLogLines, { ocppVersion: "1.6" });
```

`logLinesToTrace` drops non-wire log lines, emits the verbatim frame text in
the `raw` field, and back-fills each CALLRESULT/CALLERROR `action` from the
CALL that established its `messageId`. `logLineToTraceRecord` converts a single
line (returning `null` for non-wire lines). The type lives in
`src/trace/OcppTraceRecord.ts` and `OCPP_TRACE_SCHEMA_VERSION` is the current
version string.

## JSON Schema

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
