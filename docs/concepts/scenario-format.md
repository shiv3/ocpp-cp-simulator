---
title: Scenario file format (v1.2)
type: concept
summary: The node-graph JSON format for scripted charge-point behavior — 23 node types, edges, triggers, EV settings, assertions with a two-axis verdict — as exported by the editor and accepted by the CLI, daemon and MCP; JSON Schema is the source of truth.
sources:
  - schema/scenario.schema.json
  - src/cp/application/scenario/ScenarioTypes.ts
  - src/cp/application/verification/ScenarioAssertions.ts
  - src/scenario/scenarioSchemaValidator.ts
  - src/scenario/deepPartialMatch.ts
  - src/cp/domain/connector/ChargingCurve.ts
  - src/cp/domain/connector/MeterValueBuilder.ts
  - src/cp/domain/connector/Connector.ts
  - src/cp/domain/connector/ChargingScheduleResolver.ts
  - src/cp/domain/connector/MeterValueScheduler.ts
  - src/cp/infrastructure/transport/OCPPMessageHandlerV201.ts
  - src/cp/infrastructure/transport/soap/OCPPSoapHandler.ts
  - "issues #214, #240, #247, #239, #301"
related:
  - ../sources/scenario-json-schema.md
  - ../entities/scenario-templates.md
  - ../sources/example-scenarios.md
  - trace-format.md
  - control-plane.md
  - ../entities/cli.md
updated: 2026-09-05
---

# Scenario File Format (v1.2)

A **node-graph JSON file** describing a scripted charge-point behavior: a
directed graph of typed nodes (status changes, transactions, meter values,
CSMS-call waits, ...) connected by edges, executed by the scenario engine.
This is the format the browser [Scenario Editor](../entities/web-console.md) exports/imports, the shape
`--scenario` / `--scenario-template-file` expect on the CLI, and what
`load_scenario` / `run_scenario_file` accept over the [Socket.IO control API](control-plane.md)
— see [issue #214](https://github.com/shiv3/ocpp-cp-simulator/issues/214).

A published **JSON Schema** (Draft 2020-12) lives at
[`schema/scenario.schema.json`](../../schema/scenario.schema.json) and is the
source of truth for field names, types, and the closed vocabularies (node
`type`, `OCPPStatus`, etc.). This document is a human-readable overview of
that schema, not a replacement for it.

## Status & scope

- **Version `1.2`** (`schemaVersion`). Files stamped `1.0` or `1.1` remain valid — 1.x
  is purely additive (see [Versioning](#versioning)).
- Covers the full 23-node discriminated union the scenario engine supports
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

| Field                   | Type                                                                            | Required | Notes                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`         | string                                                                          | No       | e.g. `"1.2"` (current); `"1.1"` and `"1.0"` remain valid — additive. Absent on files predating issue #214 — still valid.                                    |
| `id`                    | string                                                                          | Yes      | Stable scenario identifier.                                                                                                                                 |
| `templateId`            | string                                                                          | No       | Set automatically when a built-in template is instantiated; absent on hand-authored scenarios. See [Template instances](#template-instances).               |
| `name`                  | string                                                                          | Yes      |                                                                                                                                                             |
| `description`           | string                                                                          | No       |                                                                                                                                                             |
| `targetType`            | `"chargePoint"` \| `"connector"`                                                | Yes      |                                                                                                                                                             |
| `targetId`              | number                                                                          | No       | Connector id if `targetType` is `"connector"`.                                                                                                              |
| `nodes`                 | [Node](#node-shape)`[]`                                                         | Yes      |                                                                                                                                                             |
| `edges`                 | [Edge](#edge-shape)`[]`                                                         | Yes      |                                                                                                                                                             |
| `createdAt`/`updatedAt` | string (ISO-8601)                                                               | No       | Most shipped templates omit these — kept optional so they still validate.                                                                                   |
| `trigger`               | `{ type: "manual" \| "statusChange", conditions?: { fromStatus?, toStatus? } }` | No       | Auto-execution trigger (default: manual).                                                                                                                   |
| `defaultExecutionMode`  | `"oneshot"` \| `"step"`                                                         | No       | Default: `oneshot`.                                                                                                                                         |
| `enabled`               | boolean                                                                         | No       | Default: `true`.                                                                                                                                            |
| `evSettings`            | `Partial<EVSettings>`                                                           | No       | `modelName`, `batteryCapacityKwh`, `maxChargingPowerKw`, `initialSoc`, `targetSoc`, plus the v1.2 curve fields — see [Charging curve](#charging-curve-v12). |
| `strictCompatibility`   | boolean                                                                         | No       | Promote warning-severity assertion failures to run failures (default: `false`). Per-run `strict` option overrides.                                          |
| `assertions`            | [Assertion](#assertions--verdicts)`[]`                                          | No       | Declarative pass/fail checks against the run's OCPP transcript.                                                                                             |

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
enum of the 23 values below), `position` (`{ x: number, y: number }`), and
`data` (an object requiring at least `label: string`; the rest of `data`'s
shape depends on `type`).

## Node types

| `type`               | Required `data` fields (beyond `label`)                          | Notable optional fields                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `statusChange`       | `status`                                                         |                                                                                                                                                                                       |
| `transaction`        | `action` (`"start"` \| `"stop"`)                                 | `tagId`, `batteryCapacityKwh`, `initialSoc`, `stopReason`                                                                                                                             |
| `meterValue`         | `value`, `sendMessage`                                           | `autoIncrement`, `outputKw`, `maxChargeKwh`, `incrementInterval`, `incrementAmount`, `stopMode`, `maxTime`, `maxValue`, `useCurve`, `curvePoints`, `autoCalculateInterval`            |
| `delay`              | `delaySeconds`                                                   |                                                                                                                                                                                       |
| `notification`       | `messageType`, `payload`                                         |                                                                                                                                                                                       |
| `connectorPlug`      | `action` (`"plugin"` \| `"plugout"`)                             |                                                                                                                                                                                       |
| `remoteStartTrigger` | —                                                                | `timeout`                                                                                                                                                                             |
| `remoteStopTrigger`  | —                                                                | `timeout`                                                                                                                                                                             |
| `statusTrigger`      | `targetStatus`                                                   | `timeout`                                                                                                                                                                             |
| `reserveNow`         | `expiryMinutes`, `idTag`                                         | `parentIdTag`, `reservationId`                                                                                                                                                        |
| `cancelReservation`  | `reservationId`                                                  |                                                                                                                                                                                       |
| `reservationTrigger` | —                                                                | `timeout`                                                                                                                                                                             |
| `start`              | —                                                                | `triggerOn` (`"connect"` \| `"status"`), `targetStatus`                                                                                                                               |
| `end`                | —                                                                |                                                                                                                                                                                       |
| `statusNotification` | `status`                                                         | `errorCode`, `info`, `vendorErrorCode`, `vendorId`, `connectorId`                                                                                                                     |
| `unlockOutcome`      | `outcome` (`"Unlocked"` \| `"UnlockFailed"` \| `"NotSupported"`) |                                                                                                                                                                                       |
| `configSet`          | `key`, `value`                                                   |                                                                                                                                                                                       |
| `dataTransfer`       | `vendorId`                                                       | `messageId`, `data`                                                                                                                                                                   |
| `csmsCallTrigger`    | `action`                                                         | `timeout`, `payload`. See [note](#csmscalltrigger-payload-condition) below.                                                                                                           |
| `responseOverride`   | `action`, `status`                                               | See [note](#responseoverride-notes) below.                                                                                                                                            |
| `inboundPolicy`      | `action`, `policy` (`"answer"` \| `"callerror"` \| `"ignore"`)   | `errorCode`, `errorDescription`. See [note](#inboundpolicy-and-certificate-quirks-notes) below.                                                                                       |
| `certQuirks`         | `mode` (`"set"` \| `"clear"`)                                    | `preset`, `csrKeyAlgorithm`, `csrPemLineEndings`, `requiredCertificateSignatureAlgorithms`, `hiddenConfigurationKeys`. See [note](#inboundpolicy-and-certificate-quirks-notes) below. |
| `connectionTrigger`  | `event` (`"connected"` \| `"disconnected"`)                      | `timeout`. See [note](#connectiontrigger-notes) below.                                                                                                                                |

`status` / `targetStatus` fields use the `OCPPStatus` enum: `Available`,
`Preparing`, `Charging`, `SuspendedEVSE`, `SuspendedEV`, `Finishing`,
`Reserved`, `Unavailable`, `Faulted`.

### `start` notes: `triggerOn: "connect"` fires on _every_ connect

A manual-trigger scenario whose start node uses `triggerOn: "connect"` (the
default) auto-starts once the charge point reaches `Available` after
BootNotification is accepted. It is armed **per connection**: losing the
WebSocket disarms it, so the scenario starts again on the next connect — even
if the previous run had already finished.

This matters for a long-lived simulator whose scenario answers CSMS-initiated
calls (a `remoteStartTrigger` responder, say). The run dies with
`Disconnected while waiting for remote start` when the socket drops, and
re-arming is what makes the simulator answer again after it reconnects rather
than going quietly unresponsive.

If a scenario must run only once per process, drive it with an explicit
`run_scenario` instead of `triggerOn: "connect"`. A status oscillation on a
still-connected charge point does **not** re-fire the scenario.

### `responseOverride` notes

Which `status` values are valid depends on `action` (e.g. `action:
"RemoteStartTransaction"` only accepts `status: "Accepted" | "Rejected"`; see
`RESPONSE_OVERRIDE_STATUSES` in
[`ScenarioTypes.ts`](../../src/cp/application/scenario/ScenarioTypes.ts)). The
schema types both fields as plain strings and does **not** enforce this
action → status constraint — encoding the full per-action status matrix
into JSON Schema would make the schema harder to read for little benefit
over the existing editor-side check. This is called out as a `$comment` in
the schema itself.

### `inboundPolicy` and certificate quirks notes

**Issue #247**: `inboundPolicy` sets a persistent policy for CSMS→CP calls
(`policy: "callerror"` sends a CALLRESULT with the given error code, `"ignore"`
sends no response, `"answer"` clears any prior policy). Policies survive
reconnects and are only cleared at the end of the scenario run or via another
`inboundPolicy` node with `policy: "answer"`.

**Issue #247 Phase 3**: `certQuirks` (mode `"set"` or `"clear"`) arms
ChargePoint domain-specific certificate behaviors. Mode `"set"` supports an
optional `preset: "octt"` (encodes legacy OCTT behaviors: RSA CSR, CRLF PEM,
RSASSA-PKCS1-v1_5 signature algorithm only, hidden CpoName config — see
[steve-community/steve#2093](https://github.com/steve-community/steve/issues/2093)).
Explicit fields override preset values. Together with `inboundPolicy` and
declarative `assertions` (e.g., `ocpp_absent`, `no_unexpected`), certificate
quirks let you emulate certification-tool strictness to verify a CP's
conformance.

### `csmsCallTrigger` payload condition

**Issue #240**: `csmsCallTrigger` accepts an optional `payload` object — a
deep-partial subset the incoming CALL's payload must match (see
`src/scenario/deepPartialMatch.ts`) for the wait to release. Only nested keys
present in `payload` are checked; extra keys on the actual CALL are ignored.
A CALL of the awaited `action` whose payload does **not** match keeps the
wait parked — the non-matching frame is not consumed, so a later matching
CALL of the same action can still resolve it. Omitting `payload` (the
pre-#240 behavior) matches any payload.

```json
{
  "id": "wait-hard-reset",
  "type": "csmsCallTrigger",
  "position": { "x": 0, "y": 0 },
  "data": {
    "label": "Wait for hard Reset",
    "action": "Reset",
    "payload": { "type": "Hard" }
  }
}
```

### `connectionTrigger` notes

**Issue #240**: `connectionTrigger` parks the scenario until the charge
point's WebSocket reaches `event` (`"connected"` or `"disconnected"`).

- **Level-triggered**, like `statusTrigger`: if the connection is already in
  the target state when the node starts, it resolves immediately rather than
  waiting for a future transition.
- **Survives disconnect**: unlike every other wait node, `connectionTrigger`
  does **not** fail when the WebSocket drops — outlasting a disconnected span
  is the point. A node with `event: "connected"` that starts while
  disconnected — say, right after a `"disconnected"` wait resolved — parks
  across the disconnected span and resolves on the reconnect rather than
  erroring. Only the optional `timeout` (seconds; `0` / absent = wait
  forever) can end the wait early, with a timeout error.
- This node only _observes_ the connection state — it never causes a
  disconnect itself. Simulating network drops is out of scope here (see
  issue #239) — that is what [Network simulation](network-simulation.md) does.

## Edge shape

```json
{ "id": "e1", "source": "start", "target": "boot-delay" }
```

`id`, `source`, `target` are required strings. xyflow adds further UI fields
(`sourceHandle`, `targetHandle`, `type`, `animated`, ...) which the schema
allows but does not require.

## Assertions & verdicts

An optional array of declarative pass/fail checks evaluated against the
run's captured OCPP transcript once a scenario finishes (see
`evaluateAssertions` in
[`ScenarioAssertions.ts`](../../src/cp/application/verification/ScenarioAssertions.ts)).
Each entry has `id` and `type` (one of `ocpp_sent`, `ocpp_received`,
`ocpp_absent`, `response_status`, `idtag_info_status`, `payload_match`,
`message_order`, `message_after`, `state_transition`, `no_unexpected`), plus
type-dependent fields (`action`, `direction`, `status`, `occurrence`,
`payload`, `targetStatus`, `actions`, `before`, `after`).

### Severity: conformance vs. compatibility

Each assertion optionally carries a `severity` field (`"failure"` or `"warning"`; default: `"failure"`):

- **`"failure"` (default)**: A normative OCPP conformance check. If it fails, the run's `conformanceVerdict` is `FAIL` and the overall scenario verdict fails.
- **`"warning"`**: A compatibility observation (e.g., an OCTT certification quirk): behavior that is legal per the OCPP specification but has been observed to trip a particular peer. If it fails, the run's `compatibilityVerdict` is `WARNING` and the run does **not** fail. Strict mode promotes such warnings to failures when either:
  - the scenario sets `strictCompatibility: true`, or
  - the run is started with `strict: true` (accepted by the `run_scenario`, `run_scenario_file`, and `run_scenario_template` RPCs; overrides the scenario-level setting).

The run report carries both axes alongside the overall `verdict`: `conformanceVerdict` (`PASS`/`FAIL`/`BLOCKED`/`SKIPPED`, from failure-severity assertions only) and `compatibilityVerdict` (`PASS`/`WARNING`/`FAIL`/`SKIPPED`, from warning-severity assertions only), plus the effective `strict` flag.

Each entry in the report's `assertions` array also carries `frameRefs` (#240): the `seq` (capture-order index) of the transcript frame(s) the assertion is about — the frame that satisfied it on pass, or the offending frame on failure (e.g. the unexpected CALL for `ocpp_absent`, the call and its response for `response_status`). Join `frameRefs` against the report's `transcript` entries (which share the same `seq`) to point a failed assertion straight at the relevant messages. It is omitted when no frame is relevant (a "never sent" miss, or a malformed spec).

**Example run report**:

```json
{
  "conformanceVerdict": "PASS",
  "compatibilityVerdict": "WARNING",
  "strict": false,
  "verdict": "PASS"
}
```

A scenario with no `assertions` produces a `SKIPPED` verdict and runs exactly as before.

### OCTT strictness probe

The bundled `cert16-octt-strictness-probe` [template](../entities/scenario-templates.md) uses warning-severity `ocpp_absent` assertions for two CSMS behaviors that are valid per OCPP 1.6 but have been observed to break OCTT certification scenarios: an automatic `GetConfiguration` right after connect, and a `GetDiagnostics` during the sequence. By default such a run reports `OCPP conformance: PASS / compatibility: WARNING`; enable strict mode (`strictCompatibility: true` or per-run `strict: true`) to promote those warnings to failures when rehearsing for an official certification run.

## Validating a scenario file

```ts
import { validateScenarioSchema } from "../../src/scenario/scenarioSchemaValidator";

const result = validateScenarioSchema(JSON.parse(fileContents));
if (!result.valid) {
  console.warn(result.errors); // advisory — do not reject on this
}
```

The simulator itself calls this at every import point (browser upload,
`--scenario` / `--scenario-template-file`, and the `load_scenario` /
`run_scenario_file` Socket.IO methods) and only ever warns — see [Status &
scope](#status--scope).

## Template instances

Loading a built-in template does not hand you the template file: it produces an
_instance_ with its own `id`
(`<templateId>-<cpId>-c<connectorId>-<timestamp>-<suffix>`) and a `templateId`
field naming what it came from. Two loads of the same template are independent
scenarios, so editing one never touches the other.

On the **daemon**, instantiating a template is idempotent per
(template, connector): the earlier instance of that template on that connector
is replaced rather than added to. Without that, every pod restart and every
`run_scenario_template` left one more copy behind in `--state-db` forever. A
different template on the same connector, or the same template on another
connector, is untouched. Instances persisted before `templateId` existed are
recognised by their id format, so an existing state DB tidies itself on the
next boot.

## Charging curve (v1.2)

`evSettings` describes an EV's _electrical_ behaviour as well as its battery
(#301). Every field is optional and absence keeps the pre-1.2 behaviour: flat
acceptance at `maxChargingPowerKw`, 230 V, single phase.

| Field           | Meaning                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| `chargingCurve` | `{ socPercent, powerFraction }[]` — piecewise-linear power acceptance against SoC. |
| `currentType`   | `AC` or `DC`. DC has no reactive component.                                        |
| `phases`        | `1` (default) or `3`, AC only.                                                     |
| `voltageV`      | **Phase-to-neutral** volts. Default 230; see below for a non-positive value.       |
| `powerFactor`   | cos φ, AC only. Range `(0, 1]`; default 1.                                         |

`chargingCurve` is normalized at every boundary it can enter through (sorted
by `socPercent`, points outside `0-100` / `0-1` dropped) — a scenario file may
list points in any order, and interpolation can otherwise assume a monotone
axis. A curve is clamped to its first and last point rather than
extrapolated: a curve that starts at 20% says nothing about 10%, and inventing
a number there would be worse than admitting it.

**A curve may repeat a SoC to step, and at that SoC the last point wins.**
Two points at the same `socPercent` describe a vertical step: the earlier one
ends the ramp into it, the later one begins the run after it. Evaluated
exactly on the step, the value _after_ it is the answer — so a curve dropping
to `powerFraction: 0` at 50% pauses a battery sitting exactly at 50%, rather
than holding it at full power. The same rule applies at either end of a curve.

**A malformed `chargingCurve` is discarded, never thrown on.** A value that is
not an array, or whose entries are not objects with numeric `socPercent` and
`powerFraction`, is dropped exactly like a point that fails the range checks;
the result is an empty curve, which is flat acceptance at
`maxChargingPowerKw` — the same as no curve at all. That disposition matters
because such a value really does arrive: `src/protocol/methods.ts` types
`evSettings` as an opaque object and validates none of its fields, so
`set_ev_settings` accepts anything, and schema validation of a scenario file
is [advisory](#status--scope) — the file loads past the warning. The guard
runs on the connector's `evSettings` setter (and so on the scenario/RPC
override path), where the stored browser default is read out of `localStorage`
— which both seeds the connector-domain override a fresh connector reads
before that setter ever runs _and_ fills the Settings page's own editor state,
so one guarded load serves both — and at the editor's import/hydration points.
Neither a meter tick nor either settings panel can be handed a curve it cannot
walk.

**Current is derived by type, not by one shared formula.** DC is `I = P / V`;
AC is `I = P / (V × phases × cos φ)`. Applying `powerFactor` to DC would report
a current the hardware could not draw — `Power.Factor` itself always reports
`1` on DC for the same reason, regardless of a configured `powerFactor`, and
the configured value on AC (default `1`), so it never disagrees with the
current derived from it in the same MeterValue.

**An amp-based charging profile is not violated by the report.** A
`ChargingRateUnit=A` period limit is converted to watts to cap the session,
and that wattage is converted back to the reported `Current.Import`. When the
connector declares an electrical model — any of `currentType`, `phases`,
`voltageV`, `powerFactor` — both halves use the same numbers, so a binding
amp limit is reported back as that amperage, and **never above it**. The
printed value carries that guarantee too: `Current.Import` is reported to one
decimal and `Power.Active.Import` to a whole watt, and rounding to nearest
rounds _up_, so a binding 16.06 A limit derived 16.06 A and then sent
`"16.1"`. A sample whose value a profile bounds is rounded **down** instead —
but only when rounding to nearest would cross the bound, never as a blanket
change of rounding mode, because flooring every sample would move
`22000 / 230 = 95.652…` from `"95.7"` to `"95.6"` and break the byte-identity
the pre-v1.2 path relies on. Under-reporting by less than one printed digit is
a rounding artefact; over-reporting is a profile violation, so that is the
half that holds. It applies to `Current.Import`, `Current.Offered`,
`Power.Active.Import` and `Power.Offered`, and to a per-phase leg against its
own third of the cap. `Voltage`, `Power.Factor`, `SoC` and the energy register
are not bounded by a charging profile and are printed unchanged.
Without that, the two halves disagreed: a 3-phase 10 A profile on a
`powerFactor: 0.5` connector resolved to `10 × 230 × 3 = 6900 W` and reported
`6900 / (230 × 3 × 0.5) = 20 A`, twice the limit. Both halves also divide by
the **phases actually in use**, not by the connector's wiring: a 10 A
single-phase profile caps a 3-phase connector at 2300 W, and dividing that
across three conductors reported 3.3 A for a line genuinely carrying 10.
`EVSettings.phases` is read in exactly one place in the domain — the helper
that resolves the active count — and neither conversion infers a phase count
of its own, so the wiring cannot stand in for the phases in use by accident. The phase count used is `min(connector phases, the period's
numberPhases)` — a profile cannot give a single-phase connector three phases
to draw on, and a CSMS restricting a 3-phase connector to one phase lowers the
cap. Any **positive** integer `numberPhases` counts, not only 1 and 3: OCPP
permits 2, so treating 2 as "absent" would cap the same profile at ×2 in one
half and ×3 in the other. Anything else — **zero**, fractional, negative,
non-finite, smuggled past the types by raw RPC — states no restriction that
can be honoured and falls back to the connector's own phase count, in every
branch of the conversion. Zero deserves naming: it looks legal, because the
bundled OCPP schemas ask only for an integer and the profile handlers do not
reject it, but a station cannot deliver on zero phases and taking it literally
divides by zero — the active count would be 0, and a positive `W`-based limit
would report `Current.Import` as `Infinity`, or `null` once serialised on
2.x. It is also not how OCPP expresses a pause; that is `limit: 0`. The
resolved active phase count is therefore never below 1, which is what makes
the current derivation's divisor safe. Its two companions are guarded the same
way: a `voltageV` that is not positive and finite reads as 230, and a
`powerFactor` outside `(0, 1]` reads as unity, so no divisor in the electrical
model can reach zero from an accepted input. This guarantee is about connectors that describe their electrics.
`GetCompositeSchedule` is deliberately outside it: that response restates the
CSMS's own profiles rather than metering a connector, so both directions there
stay on the 230 V reference and remain each other's inverse.

**Known limitation, not a guarantee: a connector declaring none of the four
electrical fields keeps the pre-1.2 mismatch.** It converts an amp limit with
`A × 230 V × numberPhases` (OCPP §7.21's default of 3 when the period names
none) and derives the current back at one phase, so a 10 A profile caps at
6900 W and reports 30 A. That is the same contradiction the rule above
removes, and it is wrong in the same way — it is preserved only because every
scenario written before v1.2 has no electrical fields, and changing it would
change their MeterValues. The byte-identity of that path is the guarantee; the
30 A is a defect inside it, recorded here so that correcting it later is
recognised as a deliberate behaviour change rather than mistaken for a
regression. Declaring any one of `currentType`, `phases`, `voltageV` or
`powerFactor` opts a connector into the corrected conversion today.

**A `Voltage` sample names the volts that produced `Current.Import`.** A
`voltageV` of zero, negative or non-finite is out of contract and is treated
as 230 V in the current derivation; the sample reports that 230, not the
configured number. Reporting the raw value put two numbers in one MeterValue
that could not both be true — `Voltage = 0` beside a current divided by 230 —
which is the same defect the `Power.Factor` rule below fixes, and gets the
same answer: report what was used, so the substitution is on the wire rather
than silent.

**A `Power.Factor` of unity is written `1.0`.** That is the literal every
pre-1.2 connector put on the wire, and settings with no electrical fields must
produce byte-identical MeterValues — a promise about the strings, since a
raw-payload or snapshot consumer compares text, not parsed numbers. Every
unconfigured connector resolves to unity (no `powerFactor`, or DC, or a value
outside `(0, 1]`), so all of them keep `"1.0"`. A configured non-unity value is
still reported exactly, which is what the rule below is for.

**A `Power.Factor` sample is never rounded.** It names the exact number that
produced `Current.Import` in the same message, so `powerFactor: 0.004` reports
`0.004`, not `0.00`. Rounding the sample to two decimals while deriving the
current from the full value made a single MeterValue contradict itself, and
rounding the derivation to match would divide by zero.

**`powerFactor: 0` is out of range, and the substitution for it is visible.**
cos φ = 0 means no real power flows, so `I = P / (V × phases × cos φ)` has no
finite answer. `schema/scenario.schema.json` gives `powerFactor` an
`exclusiveMinimum` of 0, so every load path warns about a 0 — schema
validation here is [advisory](#status--scope), so the file still loads — and
neither browser panel can produce one: both clamp to `0.01`, the smallest
value their `step` expresses. A value outside `(0, 1]` therefore still
reaches the domain, from a file loaded past the warning or from raw RPC,
which validates no `evSettings` field at all. There it is treated as unity,
and the reported `Power.Factor` sample names that `1` — so the substitution
is on the wire rather than silent. What changed is that it is no longer
_accepted_ anywhere and then quietly reinterpreted.

**The curve lowers demand and never raises it, for both the reported sample
and the register it feeds.** Effective power is `min(curve-derived power,
ChargingScheduleResolver limit)`, so an active `SetChargingProfile` always
wins — a curve cannot let a session draw above a limit the CSMS set. With a
curve configured, the energy register and derived SoC accumulate at that same
effective power, not just `Power.Active.Import` — a `powerFraction: 0` point
stops delivery outright rather than only zeroing the reported number.
Without a curve, accumulation is unchanged from before v1.2: the
increment/bezier trajectory a scenario configures is its own contract,
independent of `maxChargingPowerKw`, and only the charging-profile limit caps
it. That trajectory describes the energy delivered **in the session**, and is
shifted so that its **own first point** lands on whatever the register already
reads when the session starts — `Energy.Active.Import.Register` is cumulative
for the life of the connector, `StartTransaction` records `meterStart` as
whatever it already reads, and nothing ever resets it. So the register never
moves backwards between sessions, and a curve whose maximum is below the
current register still delivers.

The shift is by the curve's own starting ordinate, not by the register alone.
A curve may legitimately begin above zero — nothing forbids it, and the editor
allows any ordinate — and adding the register to such a curve would deliver
twice what it describes: a connector at 50 kWh running a 50→60 kWh curve would
jump to 100 kWh. What a curve fixes is the **shape** of a session's delivery;
where its ordinates start says nothing about where the register is. The two
readings coincide for a zero-based curve, which is every curve written so
far.

**A tapering curve slows the energy register; it never freezes it.** The
register is integer watt-hours — a fractional `meterStop` is rejected by a
strict CSMS with a `FormationViolation` that leaves the transaction stranded
in Charging — so the auto-meter rounds what it reports and carries the
sub-watt-hour remainder into the next tick instead of re-rounding an
already-rounded value. Without that carry, any per-tick delta under 0.5 Wh is
destroyed rather than deferred: a curve tapering to 1000 W with a 1-second
interval delivers 0.28 Wh a tick, so the register and the SoC derived from it
would sit at their starting value forever while `Power.Active.Import` kept
reporting 1000 W. The carry is reset whenever the auto-meter starts or stops,
so a session always begins on a whole watt-hour.

For the same reason, an auto-meter's `maxValue` stop condition is judged on
the delivered energy rather than on the published integer. A fractional cap
below the next half-watt-hour boundary — 10.4 Wh — is reached exactly by the
delivered value and then published as 10; a check on what was published would
never fire, and the scheduler would tick forever republishing the same 10.

The guarantee holds **across transactions**, not only within the first one. A
connector's second session starts from its cumulative register, not from zero,
so a bezier trajectory read as an absolute value would have been behind that
register from its first tick: uncapped it assigned a value below `meterStart`,
and capped it saw a negative delta, clamped it away and delivered nothing
until the trajectory climbed back past the old register — or forever, once the
register had passed the curve's maximum. Offsetting the trajectory by the
register at session start is what makes the second session behave like the
first.

`Power.Offered` / `Current.Offered` are the EVSE's own offer —
`min(maxChargingPowerKw, ChargingScheduleResolver limit)` — **not** what the
curve says the battery accepts. A 100 kW charger still offers 100 kW to a
nearly-full battery that the curve says only draws 10% of it; conflating the
two would make a charger appear to shrink as a car fills up.

On a 3-phase AC connector, `Current.Import` and `Power.Active.Import` are also
reported per phase (`L1` / `L2` / `L3`). The three power legs sum to the
aggregate `Power.Active.Import`; the three current legs each carry the same
value as the aggregate `Current.Import`, because a per-phase line current is
what `I = P / (V × phases × cos φ)` already computes — three legs of a
three-phase supply do not add up to a larger current. Energy registers are not
split — a meter has one.

**Per-phase samples are emitted only when all three phases are actually in
use.** The phase count is the connector's wiring narrowed by the tightest
`numberPhases` any applicable profile imposes — the Tx-layer profile and the
`ChargePointMaxProfile` are composed for phases **independently** of the watt
cap, because they are independent constraints and the profile that supplies
the lower wattage need not be the one that restricts the phases. A Tx profile
holding a connector to one phase stays in force even when a three-phase
station profile is what caps the watts.

**Every amp-based limit is converted on that joint phase count, not on its
own `numberPhases`.** The two constraints are independent, but the A → W
conversion depends on both, so it runs only once both are known. Converting
each profile separately and taking the tighter wattage afterwards let a limit
be exceeded on the phase actually in use: a 10 A three-phase `TxProfile`
became 6900 W beside a 3000 W single-phase `ChargePointMaxProfile`, the 3000 W
won, and delivery on the one permitted phase was about 13 A — over a 10 A
limit still in force. The joint count applies to a connector with no
electrical model too, where it can only ever narrow the cap. Under a profile restricting
a 3-phase connector to one or two phases, only the aggregate is reported: the
station must not claim consumption on phases the CSMS said it may not use, and
because OCPP's `numberPhases` says how _many_ phases, never _which_, naming a
subset of `L1` / `L2` / `L3` would invent an allocation the profile never
expressed. The restriction suppresses the per-phase detail only; the aggregate
number is unchanged, since the watt cap already governs it. `Voltage`,
`Power.Offered` and `Current.Offered` are not emitted per phase at all — the
first would be three copies of one configured phase-to-neutral value, and the
other two describe what the EVSE offers rather than what it draws, so neither
can claim consumption anywhere.

**`phase` on the wire is OCPP-version-dependent.** 1.6-J, 1.6-S SOAP, 2.0.1
and 2.1 all carry a `phase` attribute on `SampledValue`, so the L1/L2/L3 tag
survives onto the wire alongside the aggregate (untagged) sample. OCPP 1.5
SOAP's `SampledValue` has no `phase` attribute at all — sending the per-phase
samples there would produce three extra values indistinguishable from the
aggregate (same measurand, context and unit), so the 1.5 mapper drops them
and sends only the aggregate.

**OCPP 1.5 drops `Power.Offered` and `Current.Offered` entirely, and a 1.5
MeterValues.req never carries two samples with the same measurand.** OCPP 1.5
has no Offered measurand. Both used to be relabelled onto
`Power.Active.Import` / `Current.Import`, which was indistinguishable from
correct while offered and accepted power were always the same number. Under a
curve they differ, so a 1.5 connector sampling both would have sent
`Power.Active.Import = 100000` and `Power.Active.Import = 10000` in one
message — identically labelled, contradictory, with nothing on the wire to
tell a CSMS which was which. The 1.5 mapper drops the unsupported sample
instead, exactly as it already did for `Power.Factor`, `SoC`, `Frequency` and
`RPM`. The tradeoff is deliberate: a 1.5 connector configured to sample _only_
the Offered measurands gets no power sample at all, which is a smaller loss
than two answers to the same question. Every other version keeps both.

**A MeterValues request with no samples is never sent.** When every measurand
a connector is configured to sample is one its OCPP version does not define —
a 1.5 connector sampling only `Power.Offered` and `Current.Offered` is the
reachable case — the request would carry an empty value list, which OCPP
requires not to be empty and a conforming CSMS rejects. The send is skipped
and a warning names the version and the configured measurands, because from
the CSMS side "no MeterValues at all" and "MeterValues the CP could not
express" look identical, so the reason has to be visible locally. Relabelling
an Offered sample onto `Power.Active.Import` to have something to send would
be worse: it is the aliasing that was removed above, and here it would report
the EVSE's offer as the station's consumption with nothing to reveal the
substitution. Nothing is lost that was not already unavailable — as soon as
one supported measurand is configured, the request goes out with it.

**Every sample in one MeterValue describes one instant.** The watt cap and the
active phase count are both derived from the charging schedule, and each used
to resolve against its own clock reading: a period boundary falling between
the two took the cap from one period and the phase divisor from the next, so a
10 A three-phase period capped at 6900 W and was then divided as one phase and
reported as 30 A. They are resolved together from a single instant.

**A transaction opens on its own SoC, never the previous session's.** Stopping
a transaction deliberately leaves `socPercent` in place — disconnect/reconnect
paths and post-boot StatusNotifications describe the connector with it — so a
connector that finished at 95% still reads 95% when the next car plugs in.
Starting a transaction replaces any SoC that is **not waiting for it** —
derived from the meter, or set while an earlier session was running — with this
session's opening value, `transaction.initialSoc ?? evSettings.initialSoc`,
which is what `socFromMeterValue` computes on the first meter tick anyway. Without that,
the charging curve was evaluated against the previous battery for exactly one
scheduler interval — the interval that sets the session's opening power — and
for the whole session when meter/SoC sync is off, since nothing would correct
it. An SoC set while the connector was **idle** survives: a value typed into the
side panel before pressing Start, or `initialSoc` handed to
`StartTransaction`, describes the car plugged in now. It is claimed by the
session that starts next and belongs to that session only — a second
transaction with no `initialSoc` of its own falls back to
`evSettings.initialSoc` like any other. What decides is whether a transaction
was **running** when the value was written, not where the value came from:
written mid-session it describes the car then charging, and is replaced when
the next session begins. Running means begun and not yet stopped, which is not
the same as a transaction object being attached — a rejected `StartTransaction`
leaves one attached with a stop time already stamped, and the connector is idle
from that moment, so an SoC entered before retrying by hand survives into the
retry. Whether a value is still waiting is
**persisted with it** (`connector_runtime.soc_awaits_next_transaction`, schema
v12) rather than inferred on restore: a session that has ended leaves a value
that is session-owned and transaction-less, which nothing else in the snapshot
distinguishes from one set while the connector was idle. Rows written before
v12 carry no value and are read as "not waiting", so the next transaction opens
on its own SoC. The auto-meter's own cursors are deliberately _not_ persisted:
the sub-watt-hour carry is worth at most half a watt-hour and resets when a
scheduler starts, and the curve offset is re-derived when the strategy
restarts — storing an offset against a register that has since moved would be
worse than recomputing it.

**A claimed SoC becomes the session's baseline, not just its value.** Keeping
an idle-set SoC is only half of honouring it: `socFromMeterValue` derives SoC
as `transaction.initialSoc ?? evSettings.initialSoc` plus delivered energy, so
with meter/SoC sync on — the default — the first meter update would recompute
from the EV default and overwrite the number the operator entered. Claiming a
pending SoC therefore adopts it as the transaction's `initialSoc`, so every
derivation reads one number: the meter-to-SoC conversion, its inverse used by
the target-SoC auto-stop, and the SoC the charging curve is evaluated at. Being
owned and being derived from are different questions, and answering only the
first left the session running on a figure nobody entered.

**The curve is evaluated at the transaction's (or EV settings') `initialSoc`
before the first synced SoC, not 0%.** `connector.soc` is `null` until the
first synced meter tick — the normal state for a `Transaction.Begin` sample,
and for the whole session when SoC sync is disabled — so evaluating the curve
at 0 would taper (or not taper) power for the wrong reason. The fallback
order is: the connector's own synced SoC, then the transaction's
`initialSoc`, then the EV settings' `initialSoc`, then `0` as the last
resort.

The Settings page's "Default EV Settings" panel and the scenario editor's
"Scenario EV Settings" panel both expose `currentType`, `phases`, `voltageV`,
`powerFactor` and an editable `chargingCurve` point list, alongside the five
pre-1.2 fields — the v1.2 fields are not JSON/RPC-only. Both clamp
`powerFactor` to `[0.01, 1]`; the scenario editor's field left empty means
"inherit the default", not zero.

**The Settings page saves the electrical model it displays, and can always be
made to.** Its four electrical controls always render a specific value — AC,
single-phase, 230 V, cos φ 1 when nothing is set — so Apply writes those values
rather than leaving the fields absent, and the editable draft is seeded with
them too. Seeding matters as much as saving: with the draft left unseeded the
panel matched the stored state exactly whenever nothing was stored, so the
"anything to apply?" check said no and the button was disabled — the displayed
model could only be saved by someone who happened to change an unrelated field
first. Apply is enabled exactly when the screen and the stored settings
disagree, which includes a fresh page, the state right after Reset, and an
override saved before v1.2 had electrical fields. Absent fields mean "no electrical model", which selects the
pre-1.2 A → W conversion at three phases, and the page would then have been
showing single-phase while the connector metered as three: a 16 A profile
reported as 48 A. The scenario editor's panel is different by design — a field
left empty there means "inherit", and it displays empty rather than a value it
does not hold.

## Changelog

- **v1.2**: Issue #301. Adds the charging-curve and electrical fields to
  `evSettings` — `chargingCurve`, `currentType`, `phases`, `voltageV`,
  `powerFactor` (`(0, 1]`). All optional: settings without a `chargingCurve` keep flat
  acceptance at `maxChargingPowerKw`, which is what every file written before
  this produced. Purely additive, so `1.1` and `1.0` files remain valid. (A
  `rampShape` field — a ramp from session start to full acceptance — was
  proposed alongside these but dropped before release: wiring it in needs a
  ramp-duration setting `EVSettings` doesn't have, and inventing one would
  make up a number rather than expose a real control; it never shipped.)
- **v1.1**: Issue #240. Adds the `connectionTrigger` node type (waits for the
  WebSocket to connect/disconnect) and an optional `payload` deep-partial
  match condition on `csmsCallTrigger`. Both purely additive — files stamped
  `schemaVersion: "1.0"`, or no `schemaVersion` at all, remain valid.
- **v1.0**: Initial published schema (issue #214). Adds the optional
  `schemaVersion` field; documents the existing on-file shape used since the
  scenario editor's introduction. Later additive optional fields
  (`strictCompatibility`, `templateId`) were folded into this version — every
  one is optional, and consumers must ignore unknown fields.
