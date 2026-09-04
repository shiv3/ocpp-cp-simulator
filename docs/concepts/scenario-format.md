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
updated: 2026-09-04
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
| `voltageV`      | **Phase-to-neutral** volts. Default 230.                                           |
| `powerFactor`   | cos φ, AC only. Range `(0, 1]`; default 1.                                         |

`chargingCurve` is normalized when it reaches a connector (sorted by
`socPercent`, points outside `0-100` / `0-1` dropped) — a scenario file may
list points in any order, and interpolation can otherwise assume a monotone
axis. A curve is clamped to its first and last point rather than
extrapolated: a curve that starts at 20% says nothing about 10%, and inventing
a number there would be worse than admitting it.

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
`voltageV`, `powerFactor` — both halves use the same numbers, so the reported
current is at most the amperage the CSMS set. Without that, the two halves
disagreed: a 3-phase 10 A profile on a `powerFactor: 0.5` connector resolved
to `10 × 230 × 3 = 6900 W` and reported `6900 / (230 × 3 × 0.5) = 20 A`, twice
the limit. The phase count used is `min(connector phases, the period's
numberPhases)` — a profile cannot give a single-phase connector three phases
to draw on, and a CSMS restricting a 3-phase connector to one phase lowers the
cap. Any non-negative integer `numberPhases` counts, not only 1 and 3: OCPP
permits 2, and the no-model conversion below has always used the value
verbatim, so treating 2 as "absent" here would cap the same profile at ×2 in
one half and ×3 in the other. A value that is not a non-negative integer —
fractional or negative, smuggled past the types by raw RPC — falls back to the
connector's own phase count. A connector declaring **none** of the four keeps the pre-1.2 conversion,
`A × 230 V × numberPhases` with OCPP §7.21's default of 3 phases, and with it
the pre-1.2 mismatch — this guarantee is about connectors that describe their
electrics, and every scenario written before v1.2 is byte-identical.
`GetCompositeSchedule` is deliberately outside it too: that response restates
the CSMS's own profiles rather than metering a connector, so both directions
there stay on the 230 V reference and remain each other's inverse.

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
it.

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

`Power.Offered` / `Current.Offered` are the EVSE's own offer —
`min(maxChargingPowerKw, ChargingScheduleResolver limit)` — **not** what the
curve says the battery accepts. A 100 kW charger still offers 100 kW to a
nearly-full battery that the curve says only draws 10% of it; conflating the
two would make a charger appear to shrink as a car fills up.

On a 3-phase AC connector, `Current.Import` and `Power.Active.Import` are also
reported per phase (`L1` / `L2` / `L3`), summing to the aggregate. Energy
registers are not split — a meter has one.

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
