# OCPP Trace Format (v1.0)

A small, **implementation-independent** JSON/JSONL format for one OCPP message
exchange. It is intended as a shared contract between tools that _produce_ OCPP
traffic (this simulator) and tools that _analyze_ it (e.g.
[OCPP DebugKit](https://github.com/ocpp-debugkit/toolkit)), without coupling
either side to the other's internal models — see
[issue #188](https://github.com/shiv3/ocpp-cp-simulator/issues/188).

This is a **proof of concept**: it defines and versions the record shape and
ships an adapter from the simulator's own logs. Producing trace files from a run
(a `--trace-output` flag / an `analyze` subcommand) and any DebugKit integration
are deliberately later steps.

## Status & scope

- **Version `1.0`** (`schemaVersion`). Bump on any breaking change.
- This iteration recognizes **OCPP-J (JSON/WebSocket)** frames. SOAP transport
  is a documented follow-up (the format already carries a `transport` field).
- The format is usable without this simulator or DebugKit; it is a plain JSON
  object per exchange (JSONL for a stream).

## Record shape

| Field           | Type                                           | Notes                                                                              |
| --------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `schemaVersion` | string                                         | Trace schema version, e.g. `"1.0"`.                                                |
| `timestamp`     | string (ISO-8601)                              | When the message was observed.                                                     |
| `ocppVersion`   | string (optional)                              | OCPP protocol version, e.g. `"1.6"`, `"2.0.1"`.                                    |
| `transport`     | `"json"` \| `"soap"`                           | Wire transport.                                                                    |
| `chargePointId` | string (optional)                              | Charge-point identity.                                                             |
| `connectorId`   | number (optional)                              | Connector id when connector-scoped and known.                                      |
| `direction`     | `"cp-to-csms"` \| `"csms-to-cp"`               | Relative to the CP/CSMS pair.                                                      |
| `messageType`   | `"CALL"` \| `"CALLRESULT"` \| `"CALLERROR"`    | OCPP-J frame kind.                                                                 |
| `messageId`     | string (optional)                              | Correlates a CALL with its CALLRESULT/CALLERROR.                                   |
| `action`        | string (optional)                              | e.g. `"BootNotification"`. On CALLRESULT/CALLERROR, back-filled by id correlation. |
| `payload`       | any (optional)                                 | The OCPP message body.                                                             |
| `error`         | `{ code?, description?, details? }` (optional) | Populated for CALLERROR only.                                                      |
| `meta`          | object (optional)                              | Transport/execution metadata and analysis-specific extensions.                     |

## Example

```json
{
  "schemaVersion": "1.0",
  "timestamp": "2026-07-14T02:00:00.000Z",
  "ocppVersion": "1.6",
  "transport": "json",
  "chargePointId": "CP001",
  "direction": "cp-to-csms",
  "messageType": "CALL",
  "messageId": "abc-1",
  "action": "BootNotification",
  "payload": { "chargePointVendor": "Example", "chargePointModel": "Simulator" }
}
```

## Producing records

The adapter in [`src/trace/`](../src/trace/) maps this simulator's JSONL log
lines (`--log-format json`, the `logs.get` RPC, or the browser log-viewer
download) into trace records:

```ts
import { logLinesToTrace } from "../src/trace/logEntryToTrace";

const records = logLinesToTrace(jsonlLogLines, { ocppVersion: "1.6" });
```

`logLinesToTrace` drops non-wire log lines and back-fills each
CALLRESULT/CALLERROR `action` from the CALL that established its `messageId`.
`logLineToTraceRecord` converts a single line (returning `null` for non-wire
lines). The type lives in `src/trace/OcppTraceRecord.ts` and
`OCPP_TRACE_SCHEMA_VERSION` is the current version string.

## JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/shiv3/ocpp-cp-simulator/docs/trace-format.md#v1.0",
  "title": "OcppTraceRecord",
  "type": "object",
  "required": [
    "schemaVersion",
    "timestamp",
    "transport",
    "direction",
    "messageType"
  ],
  "additionalProperties": false,
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
    "error": {
      "type": "object",
      "additionalProperties": false,
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

The `allOf` conditionals mirror what the adapter emits: a `CALL` always carries
an `action`, and `error` is present only on `CALLERROR`.
