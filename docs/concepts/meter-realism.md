---
title: Meter realism
type: concept
summary: Opt-in, seeded realism of the meter a connector reports — fluctuation, power ramp-up, independent phases with line-to-neutral and line-to-line voltages, Interval and Export measurands, SampledValue overrides and units — the station main meter on connector 0 / EVSE 0, and two wire quirks (decimal comma, empty sampledValue); everything is absent by default and the default MeterValues stay byte-identical.
sources:
  - packages/core/src/cp/domain/connector/MeterRealism.ts
  - packages/core/src/cp/domain/connector/OperatingPoint.ts
  - packages/core/src/cp/domain/connector/MeterValueBuilder.ts
  - packages/core/src/cp/domain/connector/MeterValueScheduler.ts
  - packages/core/src/cp/domain/charge-point/MainMeter.ts
  - packages/core/src/cp/domain/charge-point/ChargerCapabilities.ts
  - packages/contracts/src/chargerCapabilities.ts
  - packages/core/src/cp/domain/connector/__tests__/Connector.meterRealism.test.ts
  - packages/core/src/cp/domain/connector/meterQuirks.ts
  - packages/core/src/cp/infrastructure/transport/__tests__/meterValueQuirks.bun.test.ts
  - "issues #614, #615, #616, #617, #1133, #1134"
related:
  - scenario-format.md
  - control-plane.md
  - state-persistence.md
  - ocpp-versions-and-transports.md
updated: 2026-11-25
---

# Meter realism

Without configuration a connector reports a constant voltage, reaches its power
at once and has no per-phase voltages, no Interval or Export values and no
station meter. This page describes what can be switched on, per connector and
for the station, through [`chargerCapabilities`](control-plane.md) (#614, #615,
#616, #617). Every value is resolved in the
[operating point](scenario-format.md) (`OperatingPoint.ts`), the one resolver the
energy register also reads; `MeterValueBuilder` only formats it. With no
`meter` object the default MeterValues are byte-identical to before
(`goldenWire` fixtures untouched).

## Configuration

`chargerCapabilities.connectors[].meter` (per connector) and
`chargerCapabilities.mainMeter` (station) are optional JSON, validated by the
zod schema in `packages/contracts/src/chargerCapabilities.ts` and by
`chargerCapabilitiesProblem`. They ride the existing `charge_points.charger_capabilities`
JSON column, so no schema migration was needed.

| Field (`meter.`)                   | Meaning                                                                                                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed`                             | Integer seed of every draw; 0 when absent.                                                                                                                                                                                                                             |
| `fluctuation.voltagePct`           | Half-width (0–50 %) of the uniform band around the voltage. Currents are derived from the fluctuated voltage, never past the bound's amperes: a sag lowers the power (#846).                                                                                           |
| `fluctuation.powerPct`             | Same for the load. The register follows it, so energy stays the integral of the reported power.                                                                                                                                                                        |
| `fluctuation.currentPct`           | Extra jitter on the current as a meter reads it, on top of the load.                                                                                                                                                                                                   |
| `rampUp.shape` / `durationSeconds` | `linear` or `sigmoid` ramp from 0 to full power, measured from the transaction start.                                                                                                                                                                                  |
| `phases.voltageImbalancePct`       | Presence of `phases` turns on `L1-N`, `L2-N`, `L3-N` (and unless `lineToLine: false`, `L1-L2`, `L2-L3`, `L3-L1`) Voltage samples and independent per-phase Current.Import and Power.Active.Import. The L-L voltage is computed from the two phase voltages 120° apart. |
| `phases.loadImbalancePct`          | Per-phase load deviation; the phase powers always add up to the connector power. A phase held at the bound's amperes passes its excess to the others (#846).                                                                                                           |
| `export.powerW`                    | A V2X term: while `Charging` the connector exports this power (capped by the charger and the vehicle) and imports nothing.                                                                                                                                             |
| `sampledValues[]`                  | Overrides (below).                                                                                                                                                                                                                                                     |

Rules:

- **Seeded and pure.** A draw is a hash of `(seed, whole second of the instant, channel)`, so the same seed gives the same series at the same instants and a sample set and the register tick of one second read one draw. Nothing is stored.
- **Never past the bound.** A ramped or fluctuated power is clamped to the lower of the bound (schedule limit narrowed by the charger cap, #327) and the vehicle's own ceiling: a load at full power dips and never rises above it. The bound's line current holds too: it is the bound in amperes at the nominal voltage (an A-unit profile's own amperes), so a sagging voltage lowers the power (and `Power.Offered`, and the register bound) instead of raising `Current.Import` past it (#846). With per-phase voltages (`phases.voltageImbalancePct`) the sag is their mean, even without `fluctuation`. The bound need not come from an A-unit profile: a schedule or charger cap in watts is held at its amperes too, so its power dips under a sag (a power-controlled DC charger would hold the power instead).
- **Energy and power agree** where they already did (a connector with a charging curve and a finite `maxChargingPowerKw`: `accumulationCapW` is scaled by the same factor). A curve-less connector follows its configured increment, which the same factor scales (`OperatingPoint.deliveryFactor`).
- **Three-phase only.** Per-phase detail needs all three phases in use (the rule of the per-phase samples, #301); a profile restricting the phases, a single-phase or a DC connector reports as before.

### Interval and Export measurands (#615)

On a connector with a `meter` object (even `{}`), `Energy.Active.Import.Interval`,
`Energy.Active.Export.Register`, `Energy.Active.Export.Interval`,
`Power.Active.Export` and `Current.Export` carry real values (OCPP 1.6 §7.31
Measurand; 2.0.1 MeasurandEnumType). An Interval is the energy moved since the
previous Interval sample **of the same stream**, the first one since the transaction's `meterStart`. The streams are the sampled readings (periodic, trigger, begin / end), the clock-aligned ones, and the transaction-end history of each (#607), so two readers in one tick do not take each other's interval. The export register integrates from the start of a session, not over the idle time before it.
Without a `meter` object they stay the historical `"0"` without unit. Reactive
measurands are still zero.

### SampledValue overrides and units (#616)

`sampledValues[]` entries match by `measurand` (and `phase` when given); the
first match wins. `set` may change `unit`, `location`, `context`, `phase`, fix a
`value` or `omit` the sample. A `unit` inside a family (Wh/kWh, W/kW,
varh/kvarh, var/kvar, VA/kVA, Celsius/Fahrenheit/K) converts the value, with
`decimals` (default 3); otherwise only the label changes. `multiplier` is a power
of ten of 2.0.1 `unitOfMeasure.multiplier` (the actual value is
`value × 10^multiplier`) and is sent on OCPP 2.x only; OCPP 1.6 and SOAP ignore
it, because 1.6 §7.45 UnitOfMeasure has no such field. 2.x samples now also carry
`location` when one is set.

## Station main meter (#617)

`chargerCapabilities.mainMeter` (`baseLoadW`, `voltageV`, `phases`, `seed`,
`voltagePct`, `sampledValues`) adds a meter on connector 0 (1.6 `connectorId` 0) / EVSE 0 (2.0.1 J01.FR.03, J01.FR.04: the energy samples come from the main
energy meter). It reports `Energy.Active.Import.Register`, `…Export.Register`,
`Power.Active.Import`, `Power.Active.Export`, `Voltage`, `Current.Import`,
`Power.Factor` and `Frequency` with `location: Inlet`; connector-session
measurands (`Current.Offered`, `SoC`) are not offered (J01.FR.14 note).

Its registers are cumulative and aggregate the connectors exactly: each read adds
what the connector registers moved since the previous read plus the base load
over the elapsed time (a register set backwards moves nothing); net flow decides
import or export. They are runtime state, not persisted. It is sent with
`sendMeterValue(0)`, a TriggerMessage for MeterValues with no connector or
connector 0, and with every clock-aligned sample. A DC connector's conversion
efficiency (#608) enters here: the main meter reads each connector's AC input,
`delivered / efficiency` ([Power sharing](power-sharing.md#dc-conversion-efficiency)).

## Wire quirks (#1133, #1134)

Two station options reproduce what some charge points in the field send, so a
CSMS's meter value parsing can be tested against it. They are not part of
`chargerCapabilities`: they are top-level station options, set like
`reservationAuthorizeIdTag` with `cp.create` / `cp.update`
([parameters](control-plane.md#cpcreate-parameters)), a blueprint's `params`,
the CLI flags (`--meter-value-decimal-separator`, `--empty-meter-values`,
[CLI](../entities/cli.md)) and the MCP `cp_create` tool (its schema is
`cp.create`'s). Both are off by default and persisted with `--state-db`
(columns `meter_value_decimal_separator`, `empty_meter_values`, schema v32);
the golden fixtures are unchanged.

| Option                       | Values                 | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meterValueDecimalSeparator` | `"."` (default), `","` | OCPP 1.6 only (JSON and SOAP 1.6S). `","` spells every numeric `SampledValue.value` the station sends with a decimal comma (`"112.5"` → `"112,5"`): MeterValues (periodic, clock-aligned, trigger, main meter) and every entry of StopTransaction `transactionData`. 1.6 §7.43 types `value` as a string, so the frame stays schema-valid. A signed reading (`format: "SignedData"`) and a fixed override value that is not a plain decimal number are left alone. Refused (`invalid_params` over the control plane, the constructor throws, the CLI exits 1) for OCPP 2.0.1 / 2.1, where `value` is a JSON number, and for the SOAP 1.2 / 1.5 dialects.                   |
| `emptyMeterValues`           | boolean                | The periodic (`Sample.Periodic`) and clock-aligned (`Sample.Clock`) samples of a connector with a running transaction go out with `sampledValue: []`: 1.6 `MeterValues` (JSON and SOAP 1.6S), 2.x `MeterValues` and `TransactionEvent(Updated).meterValue`. The reading is taken as usual (Interval baselines and signing move on) and its values are dropped. On SOAP 1.6S a sample counts as a transaction's when it carries a `transactionId`. Refused for the SOAP 1.2 / 1.5 dialects (their MeterValues has no list to empty). Trigger, begin / end and idle samples stay filled, and the StopTransaction / `TransactionEvent(Ended)` history keeps its real samples. |

`sampledValue` has `minItems: 1` in the 2.0.1 / 2.1 schemas, so the empty list
is deliberately non-conformant. The option does not bypass outbound validation:
like every station CALL, the frame is sent and the codec's warning
(`Outgoing MeterValues failed v201 schema validation: /meterValue/0/sampledValue must NOT have fewer than 1 items`)
is logged. The vendored OCA 1.6 schema has no `minItems` there (#1064), so a
1.6 frame passes without a warning; without the option the station never sends
an empty MeterValues on 1.6 or 2.x.

## Limits

- Fluctuation and ramp-up read the clock; the golden fixtures pin only the deterministic parts (`meter-realism-values`), the seeded series is pinned by unit tests.
- The export register, the Interval baseline and the main meter are not persisted across a daemon restart.
