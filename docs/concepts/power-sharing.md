---
title: Power sharing and DC conversion efficiency
type: concept
summary: How a station divides one power budget between its connectors (equal or active), the vendor current limit key that moves the budget, and the DC conversion efficiency the grid-side meter sees — all terms of the one operating point resolution.
sources:
  - packages/core/src/cp/domain/charge-point/PowerSharing.ts
  - packages/core/src/cp/domain/charge-point/ChargerCapabilities.ts
  - packages/core/src/cp/domain/charge-point/MainMeter.ts
  - packages/core/src/cp/domain/charge-point/ChargePoint.ts
  - packages/core/src/cp/domain/connector/OperatingPoint.ts
  - packages/contracts/src/chargerCapabilities.ts
  - "issue #608"
  - "issue #327"
related:
  - meter-realism.md
  - vehicle-behavior.md
  - scenario-format.md
  - control-plane.md
updated: 2026-11-09
---

# Power sharing and DC conversion efficiency

Without configuration connectors on one charger do not compete for power
(#327): each is capped by its own `maxDeliveryPowerW` and never clamped to a
sum. `chargerCapabilities.powerSharing` and `connectors[].dcEfficiency` (#608)
add the station side. Both are terms of `resolveOperatingPoint`, not of
`MeterValueBuilder`; absent, the output is unchanged.

## Configuration

Part of [`chargerCapabilities`](control-plane.md) (validated by the zod schema in
`packages/contracts/src/chargerCapabilities.ts` and `chargerCapabilitiesProblem`;
stored in the same `charge_points.charger_capabilities` column, no migration).

| Field                       | Meaning                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `powerSharing.totalPowerW`  | The station's total power in watts.                                                                                                          |
| `powerSharing.strategy`     | `equal` (default): split between all connectors always. `active`: split between connectors with a running transaction.                       |
| `powerSharing.currentLimit` | `{ key, valueA, voltageV = 230, phases = 3 }`: a non-standard configuration key carrying the station current limit; budget = A × V × phases. |
| `connectors[].dcEfficiency` | Fraction of the AC input that reaches a DC vehicle, above 0 and at most 1.                                                                   |

`powerSharing` needs `totalPowerW` or `currentLimit`; when both are set the lower
budget applies.

## Allocation

`connectorShareW` is a water-filling split: every connector in the split gets an
equal part of the budget, a part above a connector's own `maxDeliveryPowerW` is
passed on to the others, so the shares add up to the budget whenever the caps
allow. Under `active` a connector without a running transaction is shown the
share it would get on joining, so a transaction that starts finds its cap in
place.

The share is not stored: each connector reads it at every operating point
resolve from the transactions running at that instant, so a transaction that
starts or stops moves every share at once (recalculation needs no bookkeeping and
cannot go stale). In the point it is the `stationShareW` of the charger term:
the connector's cap is `min(maxDeliveryW, stationShareW)`, so it narrows the
offer, the acceptance, the energy register, `Power.Active.Import`,
`Power.Offered` and `Current.Import` together, and `limitedBy` reads `charger`.
The CSMS charging profile and the vehicle demand ([Vehicle behavior](vehicle-behavior.md))
narrow further, never wider.

## The current limit key

`currentLimit.key` is declared as a writable integer configuration key (minimum 1)
with `valueA` as its value. OCPP 1.6 §5.3 answers `NotSupported` to a key the
station does not know; for the declared one `ChangeConfiguration` answers
`Accepted`, stores the value (it survives a restart like any configuration
override) and the next resolve uses the new budget. A value below the bound is
`Rejected`. A key that already is a standard or runtime key is not shadowed: the
declared limit is ignored with a warning. The key is a 1.6 / configuration-store
concept; 2.x stations read the same stored value, which a device-model write can
set once the variable is exposed.

## DC conversion efficiency

A DC connector with `dcEfficiency` e < 1 draws `delivered / e` from the grid. The
operating point carries `conversionEfficiency` and `inputW = acceptedW / e` (only
for a vehicle whose `currentType` is `DC`; an AC vehicle is unaffected). The
vehicle side — SoC, the connector's own energy register and samples — is
unchanged. The loss shows on the **AC input side**: the [station main
meter](meter-realism.md#station-main-meter-617) (connector 0 / EVSE 0,
`location: Inlet`) sums `inputW` for `Power.Active.Import`, `Current.Import` and
accumulates the connector's energy divided by e in its import register. A station
without a main meter has no AC-side measurement to show it on.

## Limits

- Sharing does not look at what each vehicle currently asks for: a connector
  that takes less than its share does not hand the rest on (only the hardware
  cap does).
- Only the active-power budget is modelled; there is no per-phase balancing.
- V2X export is not converted.
- The budget is configured inside the station; there is no run-time external
  limit from an EMS or LMS. The design note
  [EMS / LMS co-simulation interop](../analyses/ems-lms-cosimulation-interop.md)
  (#931) proposes one as a separate term.
