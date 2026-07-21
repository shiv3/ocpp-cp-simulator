# Scenario File Format (v1.0)

A **node-graph JSON file** describing a scripted charge-point behavior: a
directed graph of typed nodes (status changes, transactions, meter values,
CSMS-call waits, ...) connected by edges, executed by the scenario engine.
This is the format the browser Scenario Editor exports/imports, the shape
`--scenario` / `--scenario-template-file` expect on the CLI, and what
`load_scenario` / `run_scenario_file` accept over the Socket.IO control API
— see [issue #214](https://github.com/shiv3/ocpp-cp-simulator/issues/214).

A published **JSON Schema** (Draft 2020-12) lives at
[`schema/scenario.schema.json`](../schema/scenario.schema.json) and is the
source of truth for field names, types, and the closed vocabularies (node
`type`, `OCPPStatus`, etc.). This document is a human-readable overview of
that schema, not a replacement for it.

## Status & scope

- **Version `1.0`** (`schemaVersion`).
- Covers the full 20-node discriminated union the scenario engine supports
  (see [Node types](#node-types) below).
- **Validation against this schema is advisory in this version**: the
  simulator warns (`console.warn` in the browser, stderr / server log on the
  CLI and daemon) on a mismatch but **never refuses to load a file**. This
  keeps every scenario file written before this schema existed — none of
  which carry `schemaVersion` or `createdAt`/`updatedAt` — working exactly
  as before.

## Versioning

Mirrors the [OCPP trace format](./trace-format.md#versioning)'s rules:

- Additive optional fields bump the **minor** version.
- Consumers **MUST ignore unknown fields** — real editor exports carry
  [xyflow](https://reactflow.dev/) UI fields (`width`, `height`, `selected`,
  `style`, ...) that this schema deliberately does not reject
  (`additionalProperties: true` at every object level: root, node, node
  `data`, and edge).
- Changing the meaning of an existing field, or removing one, is a new
  **major** version.
- A published version is immutable: any change that alters what a
  conformant file must look like is a new version, not an edit.

## Top-level fields

| Field                   | Type                                                                            | Required | Notes                                                                               |
| ----------------------- | ------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `schemaVersion`         | string                                                                          | No       | e.g. `"1.0"`. Absent on files predating issue #214 — still valid.                   |
| `id`                    | string                                                                          | Yes      | Stable scenario identifier.                                                         |
| `name`                  | string                                                                          | Yes      |                                                                                     |
| `description`           | string                                                                          | No       |                                                                                     |
| `targetType`            | `"chargePoint"` \| `"connector"`                                                | Yes      |                                                                                     |
| `targetId`              | number                                                                          | No       | Connector id if `targetType` is `"connector"`.                                      |
| `nodes`                 | [Node](#node-shape)`[]`                                                         | Yes      |                                                                                     |
| `edges`                 | [Edge](#edge-shape)`[]`                                                         | Yes      |                                                                                     |
| `createdAt`/`updatedAt` | string (ISO-8601)                                                               | No       | Most shipped templates omit these — kept optional so they still validate.           |
| `trigger`               | `{ type: "manual" \| "statusChange", conditions?: { fromStatus?, toStatus? } }` | No       | Auto-execution trigger (default: manual).                                           |
| `defaultExecutionMode`  | `"oneshot"` \| `"step"`                                                         | No       | Default: `oneshot`.                                                                 |
| `enabled`               | boolean                                                                         | No       | Default: `true`.                                                                    |
| `evSettings`            | `Partial<EVSettings>`                                                           | No       | `modelName`, `batteryCapacityKwh`, `maxChargingPowerKw`, `initialSoc`, `targetSoc`. |
| `assertions`            | [Assertion](#assertions)`[]`                                                    | No       | Declarative pass/fail checks against the run's OCPP transcript.                     |

## Node shape

```json
{
  "id": "start-tx",
  "type": "transaction",
  "position": { "x": 400, "y": 1080 },
  "data": { "label": "StartTransaction", "action": "start", "tagId": "TAG-1" }
}
```

Every node has `id` (string), `type` (the discriminator — a closed
enum of the 20 values below), `position` (`{ x: number, y: number }`), and
`data` (an object requiring at least `label: string`; the rest of `data`'s
shape depends on `type`).

## Node types

| `type`               | Required `data` fields (beyond `label`)                          | Notable optional fields                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `statusChange`       | `status`                                                         |                                                                                                                                                                            |
| `transaction`        | `action` (`"start"` \| `"stop"`)                                 | `tagId`, `batteryCapacityKwh`, `initialSoc`, `stopReason`                                                                                                                  |
| `meterValue`         | `value`, `sendMessage`                                           | `autoIncrement`, `outputKw`, `maxChargeKwh`, `incrementInterval`, `incrementAmount`, `stopMode`, `maxTime`, `maxValue`, `useCurve`, `curvePoints`, `autoCalculateInterval` |
| `delay`              | `delaySeconds`                                                   |                                                                                                                                                                            |
| `notification`       | `messageType`, `payload`                                         |                                                                                                                                                                            |
| `connectorPlug`      | `action` (`"plugin"` \| `"plugout"`)                             |                                                                                                                                                                            |
| `remoteStartTrigger` | —                                                                | `timeout`                                                                                                                                                                  |
| `remoteStopTrigger`  | —                                                                | `timeout`                                                                                                                                                                  |
| `statusTrigger`      | `targetStatus`                                                   | `timeout`                                                                                                                                                                  |
| `reserveNow`         | `expiryMinutes`, `idTag`                                         | `parentIdTag`, `reservationId`                                                                                                                                             |
| `cancelReservation`  | `reservationId`                                                  |                                                                                                                                                                            |
| `reservationTrigger` | —                                                                | `timeout`                                                                                                                                                                  |
| `start`              | —                                                                | `triggerOn` (`"connect"` \| `"status"`), `targetStatus`                                                                                                                    |
| `end`                | —                                                                |                                                                                                                                                                            |
| `statusNotification` | `status`                                                         | `errorCode`, `info`, `vendorErrorCode`, `vendorId`, `connectorId`                                                                                                          |
| `unlockOutcome`      | `outcome` (`"Unlocked"` \| `"UnlockFailed"` \| `"NotSupported"`) |                                                                                                                                                                            |
| `configSet`          | `key`, `value`                                                   |                                                                                                                                                                            |
| `dataTransfer`       | `vendorId`                                                       | `messageId`, `data`                                                                                                                                                        |
| `csmsCallTrigger`    | `action`                                                         | `timeout`                                                                                                                                                                  |
| `responseOverride`   | `action`, `status`                                               | See [note](#responseoverride-notes) below.                                                                                                                                 |

`status` / `targetStatus` fields use the `OCPPStatus` enum: `Available`,
`Preparing`, `Charging`, `SuspendedEVSE`, `SuspendedEV`, `Finishing`,
`Reserved`, `Unavailable`, `Faulted`.

### `responseOverride` notes

Which `status` values are valid depends on `action` (e.g. `action:
"RemoteStartTransaction"` only accepts `status: "Accepted" | "Rejected"`; see
`RESPONSE_OVERRIDE_STATUSES` in
[`ScenarioTypes.ts`](../src/cp/application/scenario/ScenarioTypes.ts)). The
schema types both fields as plain strings and does **not** enforce this
action → status constraint — encoding the full per-action status matrix
into JSON Schema would make the schema harder to read for little benefit
over the existing editor-side check. This is called out as a `$comment` in
the schema itself.

## Edge shape

```json
{ "id": "e1", "source": "start", "target": "boot-delay" }
```

`id`, `source`, `target` are required strings. xyflow adds further UI fields
(`sourceHandle`, `targetHandle`, `type`, `animated`, ...) which the schema
allows but does not require.

## Assertions

An optional array of declarative pass/fail checks evaluated against the
run's captured OCPP transcript once a scenario finishes (see
`evaluateAssertions` in
[`ScenarioAssertions.ts`](../src/cp/application/verification/ScenarioAssertions.ts)).
Each entry has `id` and `type` (one of `ocpp_sent`, `ocpp_received`,
`ocpp_absent`, `response_status`, `idtag_info_status`, `payload_match`,
`message_order`, `message_after`, `state_transition`, `no_unexpected`), plus
type-dependent fields (`action`, `direction`, `status`, `occurrence`,
`payload`, `targetStatus`, `actions`, `before`, `after`). A scenario with no
`assertions` produces a `SKIPPED` verdict and runs exactly as before.

## Validating a scenario file

```ts
import { validateScenarioSchema } from "../src/scenario/scenarioSchemaValidator";

const result = validateScenarioSchema(JSON.parse(fileContents));
if (!result.valid) {
  console.warn(result.errors); // advisory — do not reject on this
}
```

The simulator itself calls this at every import point (browser upload,
`--scenario` / `--scenario-template-file`, and the `load_scenario` /
`run_scenario_file` Socket.IO methods) and only ever warns — see [Status &
scope](#status--scope).

## Changelog

- **v1.0**: Initial published schema (issue #214). Adds the optional
  `schemaVersion` field; documents the existing on-file shape used since the
  scenario editor's introduction.
