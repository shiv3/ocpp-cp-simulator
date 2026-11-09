---
title: Vehicle behavior
type: concept
summary: What a vehicle wants and when — the protocol-independent behavior domain (packages/vehicle), its policies and presets, how its demand enters the operating point, how it drives EV readiness, and how it can be extracted into its own repository.
sources:
  - packages/vehicle/src/contracts.ts
  - packages/vehicle/src/evaluate.ts
  - packages/vehicle/src/VehicleBehaviorEngine.ts
  - packages/vehicle/src/presets.ts
  - packages/vehicle/src/config.ts
  - packages/core/src/cp/domain/connector/OperatingPoint.ts
  - packages/core/src/cp/domain/connector/Connector.ts
  - packages/core/src/cp/domain/charge-point/VehicleBehaviorDriver.ts
  - scripts/check-package-boundaries.ts
  - "issue #835"
  - "issue #453"
  - "issue #327"
related:
  - scenario-format.md
  - vehicle-profiles.md
  - power-sharing.md
  - meter-realism.md
  - control-plane.md
  - ../overview.md
updated: 2026-11-09
---

# Vehicle behavior

A vehicle is more than a battery with a charging curve: it decides when to ask
for energy, how much, when to pause and when it is done (#835). That decision is
the **vehicle behavior**. It lives in its own package, `packages/vehicle`
(`@ocpp-cp-simulator/vehicle`), which knows nothing of OCPP, connectors,
transports, React or the scenario runtime. The simulator adapts what it
outputs; it never reaches into it.

| Concept          | Responsibility                                       | Where                                                                             |
| ---------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| Vehicle profile  | What the vehicle can do (ceiling, curve, battery)    | [Vehicle profiles](vehicle-profiles.md), `EVSettings` (#327)                      |
| Physical state   | Connected, ready or not ready                        | `Connector.evConnection` (#453)                                                   |
| Vehicle behavior | What it wants and when                               | this page                                                                         |
| Delivered power  | `min(demand, vehicle, curve, CSMS profile, charger)` | `resolveOperatingPoint` ([Scenario format → operating point](scenario-format.md)) |

## Domain contracts

All time is epoch milliseconds, power is watts, energy is watt-hours.

- `ChargingIntent` — `targetSoc`, `requestedEnergyWh`, `departureAt`. An
  objective is **met** when any named criterion is reached; it is **unmet**
  when `departureAt` has passed with the objective still open.
- `VehicleBehaviorPolicy` — when the vehicle asks (table below).
- `VehicleDemand` — `requestedPowerW`, `readyToCharge`, `stopRequested`,
  `reason`. No protocol term appears in it. `requestedPowerW` is `Infinity` for
  a vehicle with no known ceiling and no step in force, and `0` while not ready.
- `VehicleSnapshot` — `phase` (`waiting`, `charging`, `suspended`, `complete`,
  `departed`), `demand`, `objective` (`none`, `pending`, `met`, `unmet`, with the
  SoC and energy still missing) and `elapsedMs`. Demand and objective are
  observable apart from each other and from the delivered power.

`evaluateVehicleBehavior(spec, profile, state, observation, now)` is a pure
function: the same inputs give the same snapshot. `VehicleBehaviorEngine` wraps
it with an injected clock and the explicit `VehicleSessionState`
(`{ startedAt }`) for a consumer that does not carry the state itself. Nothing in
the package reads a clock, a random source or the environment, so a session
replays exactly.

### Policies

| `policy.type`      | The vehicle asks for energy…                                                                                 | Ends by itself at the objective     |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `immediate`        | from the plug-in on                                                                                          | no (the objective is only reported) |
| `target-soc`       | from the plug-in on, until the objective is met                                                              | yes                                 |
| `delayed`          | after `delayMs` from the plug-in                                                                             | yes                                 |
| `scheduled-window` | inside the daily `windows` (`startMinute`, `endMinute`, wrapping past midnight; `utcOffsetMinutes`)          | yes                                 |
| `manual-suspend`   | except during the `pauses` (`afterMs`, `durationMs`): an EV-initiated suspend and resume                     | yes                                 |
| `demand-steps`     | at the lowest `maxPowerW` of the latest step in force (`null` lifts it): a dynamic reduction and restoration | yes                                 |

A `demand-steps` request of 0 W is a request for nothing, not a disconnect: the
vehicle stays `charging` and ready. `stopRequested` is true only when the spec
sets `stopWhenDone` and the objective is met or the vehicle departed; by default
a reached target **stops the demand without ending the transaction**.

## Presets

`VEHICLE_BEHAVIOR_PRESETS` (selected by `vehicleBehavior.preset`): `immediate`,
`target-soc`, `delayed-15min`, `overnight` (22:00–07:00 UTC), `ev-pause-resume`
(2 minutes paused after 5) and `demand-dip` (3.7 kW from minute 5, restored at
minute 10). A config may override a preset's `policy`, `intent` fields and
`stopWhenDone`.

## In the simulator

`EVSettings.vehicleBehavior` (`{ preset?, policy?, intent?, stopWhenDone? }`)
selects the behavior. Because it is an EV-settings field it travels through
every surface that writes EV settings: `set_ev_settings` (a merge patch, `null`
removes it), a scenario's `evSettings`, the Local-mode settings. A behavior that
cannot run (unknown preset, malformed policy, `targetSoc` outside 0–100) is
refused before anything is written, as `invalid_params` over the control plane.
No behavior set means the vehicle asks for all it can take, as before.

- **Intent.** The session's target SoC (`transaction.targetSoc ??
evSettings.targetSoc`) is the intent unless `intent` overrides it; progress is
  the connector's SoC and the energy since the transaction's `meterStart`.
- **Time origin.** The behavior's clock starts when the cable is plugged in
  (`evPlugIn`, or the transaction when it starts without a plug-in). A daemon
  restart re-starts it.
- **Demand → power.** The connector puts the demand into the one
  `resolveOperatingPoint` as a `demand` term: it caps what the battery accepts
  (`acceptedW`, `accumulationCapW`, so the register, `Power.Active.Import` and
  `Current.Import` agree), after the charging curve. It never raises a limit and
  never changes the offer: `Power.Offered` stays the EVSE's, and a CSMS charging
  profile is never rewritten. `limitedBy` reads `vehicle` when the demand
  binds.
- **Readiness.** `VehicleBehaviorDriver` (one per connector, no timer without a
  behavior) reads the demand once a second and on every transaction, status and
  settings change, and calls the existing `ChargePoint.evSetReady` (#453) — the
  one code path of a manual ready/not-ready. A vehicle that is waiting, paused or
  done therefore appears as `SuspendedEV` on OCPP 1.6 (§4.9, transitions C4 and
  D3, StatusNotification) and as `TransactionEvent` `Updated` with
  `chargingState` `SuspendedEV` on 2.0.1 (ChargingStateEnumType). The driver
  reacts after the event that caused it, never inside it, so the wire order is
  that of the events. While a behavior is set it owns the readiness: a manual
  `evSetReady` is overwritten on the next look.
- **2.x and an energy offer that has not started.** The driver suspends and
  resumes a connector the EVSE is energizing. On 2.0.1 a transaction can sit in
  `Preparing` until something starts the energy offer (the simulator does not
  start it by itself); there the driver only records the vehicle as not ready,
  and the `SuspendedEV` update follows once the connector is `Charging`.
- **StartTransaction.conf.** An EV that already is `SuspendedEV` with its energy
  offer withheld stays so when the CSMS accepts the transaction (1.6 §4.8); it
  was driven to `Charging` before.
- **Stop.** With `stopWhenDone` the driver ends the transaction like the
  target-SoC auto-stop does (`triggerReason` `EnergyLimitReached` on 2.x).
- **Protocol honesty.** OCPP 1.6 cannot carry charging intent, and nothing here
  pretends it can. ISO 15118 charging needs, V2G and battery physics are out of
  scope.

Not yet connected: background traffic (#300) still draws sessions by duration;
it can instantiate a `VehicleBehaviorSpec` through the same package.

## Architecture rule and extraction

`scripts/check-package-boundaries.ts` lists `vehicle` with **no** allowed
dependencies, so it cannot import any other package of the repository; `packages/vehicle/src/__tests__/boundary.test.ts` keeps the same rule
beside the code (relative imports only, no `dependencies`). To publish the
package or move it to its own repository, copy `packages/vehicle/`, give it a
real name and version in `package.json` and replace the `exports` map; the
contracts do not change, and the simulator then imports it by name. Do that when
a second consumer exists.

## Tests

`packages/vehicle/src/__tests__` (the policies, departure met and unmet, replay,
the boundary), `OperatingPoint.demand.test.ts` (EV demand below and above the
CSMS allocation, the charger cap, the curve), `VehicleBehaviorDriver.test.ts`
(pause, resume, dip and stop on a virtual clock) and
`vehicleBehavior.bun.test.ts` (the 1.6 and 2.0.1 wire effects).
