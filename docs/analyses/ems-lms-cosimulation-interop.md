---
title: EMS / LMS and energy co-simulation interoperability (spike)
type: analysis
summary: Design note for #931 — how an external EMS, LMS or energy co-simulation can drive this simulator as a virtual charge point; recommended integration surface (a daemon electrical.* RPC family over one new operating-point term), API sketch, what exists, risks, verified upstream facts and a staged follow-up list.
sources:
  - packages/core/src/cp/domain/connector/OperatingPoint.ts
  - packages/core/src/cp/domain/charge-point/PowerSharing.ts
  - packages/core/src/cp/domain/charge-point/MainMeter.ts
  - packages/core/src/cp/shared/clock.ts
  - packages/core/src/cp/domain/connector/__tests__/OperatingPoint.externalLimit.feasibility.test.ts
  - packages/contracts/src/methods.ts
  - packages/contracts/src/behavior.ts
  - "issue #931"
related:
  - ../concepts/power-sharing.md
  - ../concepts/charger-engine.md
  - ../concepts/control-plane.md
  - ../concepts/power-loss.md
  - ../concepts/smart-charging.md
  - ../concepts/meter-realism.md
updated: 2026-11-14
---

# EMS / LMS and energy co-simulation interoperability (spike)

[Issue #931](https://github.com/shiv3/ocpp-cp-simulator/issues/931) asks how
OpenEMS, EVerest, ACN-Sim, pandapower or a third-party LMS/EMS can use this
simulator as a charge point _inside their_ simulation. The direction is fixed
by the issue and kept here: **the external system owns the site (topology, grid
constraints, PV, storage, allocation algorithm); this project owns the virtual
EVSE and its consistent physical state.** This page is a design note, not a
decision of the maintainer: every choice below is marked **Decision** with the
rejected alternative, and the follow-up list is a proposal (no issues were filed).

## Recommendation in one paragraph

Add **one new, independent term to `resolveOperatingPoint`** (external
electrical limits, by source, with a lease), a **`electrical.*` RPC family in
the existing Socket.IO / MCP control plane** to set, clear and read them, and
a **versioned electrical snapshot plus coalesced event** read from the same
`OperatingPoint` that feeds the energy register and MeterValues. First
consumer: **a small external controller over Socket.IO in real-time mode**,
proven against **OpenEMS** (it already speaks OCPP as a CSMS, so the
CSMS-profile path and the electrical path can be compared on one site). Defer
Modbus TCP, step-mode time and FMI. Do not put an EMS, grid model or OpenADR
stack in the simulator.

## What exists today (checked in code)

| Need                                 | Existing building block                                                                                                                                                                                                                                                            | Limit                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| One resolution of the physical state | `resolveOperatingPoint` (`OperatingPoint.ts`, #327): `scheduleLimitW`, `chargerCapW`, `boundW`, `acceptedW`, `offeredW`, `inputW`, `currentA`, `soc`, `limitedBy`; pure, no clock. `Connector.operatingPoint()` is its only caller path; the register tick and MeterValues read it | Terms are schedule, vehicle, session, charger (+ station share), fault, meter, demand. **No term for an outside controller** |
| Station-local budget                 | `PowerSharing.ts` / `ChargerTerm.stationShareW` (#608): a cap computed _inside_ one charger from config                                                                                                                                                                            | Configured, not set by an outside party at run time; not a site allocator                                                    |
| Grid side                            | `MainMeter` (EVSE 0) aggregates connectors; `OperatingPoint.inputW` is AC input incl. DC efficiency                                                                                                                                                                                | Read side only                                                                                                               |
| CSMS allocation                      | `ChargingScheduleResolver` / `ChargingProfileStore`                                                                                                                                                                                                                                | Must stay CSMS-owned                                                                                                         |
| Demand of the vehicle                | `DemandTerm` (#835), `set_ev_settings`, `ev_ready`                                                                                                                                                                                                                                 | EV-owned; an EMS must not write it                                                                                           |
| Read model                           | `ConnectorSnapshot.power` (`packages/contracts/src/behavior.ts`): `acceptedW`, `offeredW`, `soc`, one `limitedBy`                                                                                                                                                                  | Behavior API only; no input power, currents, energy, limits by source, version, tick                                         |
| Control plane                        | Socket.IO `rpc` + `event` rooms (`events.subscribe`), MCP `call_method`, CLI JSON mode, all from one `METHODS` table (`packages/contracts/src/methods.ts`)                                                                                                                         | No electrical method; `set_meter_value` writes a reading, not a limit                                                        |
| Network vs power loss                | `network_sim.*` and `power.loss` / `power.restore` (#455) are separate                                                                                                                                                                                                             | An external limit store is a third, independent thing (below)                                                                |
| Simulated time                       | `VirtualClock` with `advanceTo`, scoped per charger (`clock.ts`)                                                                                                                                                                                                                   | See "Time"                                                                                                                   |

`set_meter_value` is not a substitute for an electrical limit, as the issue says:
it changes what is reported, not what the vehicle can take.

## Evidence produced by this spike

- **Feasibility test**
  ([`OperatingPoint.externalLimit.feasibility.test.ts`](../../packages/core/src/cp/domain/connector/__tests__/OperatingPoint.externalLimit.feasibility.test.ts),
  5 tests, passing). Passing an extra cap through the existing resolver, with
  a 9 kW profile, a 6 kW external cap and 11 kW EV demand, gives
  `acceptedW = offeredW = accumulationCapW = 6 000`, the profile still resolves
  to 9 kW (nothing written to the profile or to EV settings), removing the cap
  gives 9 kW at once, a cap above everything changes nothing, 16 A on 3 x 230 V
  converts to 11 040 W and reads back as 16 A through the point's own current
  path, and on DC a 6 kW cap on the output leaves `inputW` at 6 316 W while a
  grid-side cap needs the output cap multiplied by the efficiency. **It also
  shows one gap**: with the stand-in term the reason reads `"charger"`, so
  `limitedBy` needs an `"external"` value.
- **Cost of a read**: `Connector.operatingPoint()` took 1.2 µs per call
  (200 000 calls, Bun, this sandbox, one connector with a curve-less EV). A
  fleet snapshot of thousands of connectors is milliseconds; the cost is the
  serialization and the wire, not the resolution. One machine, one run; not a
  benchmark of the daemon.
- **Not produced**: an end-to-end run with a real CSMS and a real external
  project. See "Verified and unverified".

## External projects

Versions are the latest release tags / default branches read through the GitHub
API on 2026-11-14. **Nothing below was run**: these are facts read from
directory listings, source files and interface definitions, not interoperability
tests.

| Project                                                                                                        | Seen                                                                                                                                                                                                                                                                                                                  | What it offers at the seam                                                                                                                                                                                                                               | Fit |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| **OpenEMS** (2026.11.0, repo license reported as AGPL-3.0, OCPP bundle declares EPL-2.0)                       | `io.openems.edge.evse.api` (`EvseChargePoint.apply(ChargePointActions)`; set points in mA / W, `MIN_CURRENT = 6000` mA, W-to-mA conversion by phase count); `io.openems.edge.simulator` `evcs/SimulatorEvcs` (`applyChargePowerLimit(W)`, 3 phases); `io.openems.edge.evcs.ocpp.server` (OpenEMS as an **OCPP CSMS**) | It can already reach us over OCPP. The electrical port adds what OCPP cannot: a limit without a CSMS, while OCPP is down. Best first real consumer. Modbus for EVSE exists per vendor (`evse.chargepoint.*`); no generic register map was verified       |
| **LF Energy EVerest** (everest-core 2026.02.2, Apache-2.0)                                                     | `modules/EnergyManagement/EnergyManager`, `EnergyNode`; `interfaces/external_energy_limits.yaml` (`set_external_limits` on an energy-tree node, "e.g. from ocpp"), `energy.yaml`; `modules/EVSE/EvseManager`; `modules/Simulation/EvseManagerSimulator`                                                               | EVerest is a charger _stack_, the opposite side: its EvseManager is the charger. Using us as its EVSE would mean replacing hardware modules, not a port. **Defer**; at most a later adapter that maps our snapshot to its energy interface. Not embedded |
| **ACN-Sim** (acnportal v0.3.3, BSD-3-Clause per GitHub)                                                        | `Simulator(period = minutes)`, `Simulator.step(new_schedule)` taking per-station pilot-signal schedules, `network.update_pilots(...)`, `Interface.last_applied_pilot_signals` / `last_actual_charging_rate`, `max_pilot_signal`, `evse_voltage`                                                                       | A step-driven Python API: pilots in amperes per period in, observed rates out. Natural **second** consumer, and it needs step mode (below). Adapter lives outside this repo (Python)                                                                     |
| **pandapower** (v3.5.6; GitHub could not detect an SPDX license, BSD-style per its own docs, **not verified**) | Not inspected beyond the release; the issue's model (time-indexed load into a power flow, available power back) is **speculation** on our side                                                                                                                                                                        | A co-simulation orchestrator would read `inputW` per step and write limits. Nothing needed from us beyond the same snapshot and limit calls                                                                                                              |
| **Modbus TCP**                                                                                                 | Not evaluated; no existing register maps were checked                                                                                                                                                                                                                                                                 | Follow-up only, behind the RPC contract once a consumer needs it                                                                                                                                                                                         |
| **OpenADR**                                                                                                    | Not implemented                                                                                                                                                                                                                                                                                                       | Boundary: VEN/VTN belongs to the site EMS; we consume the resulting limit                                                                                                                                                                                |

## Decisions

### D1. Where the port lives

**Decision:** the pure store and the term live in `packages/core`
(`cp/domain/connector`, protocol-agnostic like `OperatingPoint.ts`, no
`ocpp/` import, so the browser Local mode gets it for free); the wire contract
(`electrical.*` schemas) lives in `packages/contracts`; the daemon, MCP and the
`@ocpp-cp-simulator/client` service expose it. **Rejected:** a new package
(no second consumer of the pure code yet); an interface named after the
illustrative `ElectricalSimulationPort` in the issue (it hides ordering and
errors behind promises; the control plane already is the port).

### D2. Surface

**Decision:** daemon RPC (Socket.IO `rpc`, reachable from MCP `call_method` and
CLI JSON mode like every method in the `METHODS` table), and the existing `event`
push for changes. **Rejected for now:** HTTP, Modbus (more adapters, each owns
a copy of the semantics), a separate port in the daemon.

### D3. Limits are an independent term, never a writer of other state

External limits are a term of `resolveOperatingPoint`, next to the schedule,
charger and demand terms. They never write `ChargingProfileStore`, `EVSettings`
or the OCPP configuration, so OCPP semantics and the golden-wire fixtures are
untouched by construction. With no limit set the new term is `Infinity` and the
output is bit-identical (to be pinned by a golden-wire run in the first PR).

Resolution: `boundW = min(scheduleLimitW, chargerCapW, externalCapW)`, as the
feasibility test shows. `limitedBy` gains `"external"`; the snapshot lists every
binding reason, not only the first.

### D4. Units and conversion

W and A, both optional, at least one required; if both, the lower wins after
conversion. A converts with the **point's own** voltage, phases and power
factor (`currentAmpsFor` and its inverse), so a limit in A and the reported
`Current.Import` cannot disagree (#301 class). `phaseCount` (1 or 3) may narrow
the phases for the conversion only where the station can switch phases;
otherwise it is refused, not ignored.

**DC side:** the issue leaves open whether a cap applies to the connector
output or the grid input. **Decision:** the cap is a **grid-side (input)** limit
by default, because the external system owns the grid and measures there; the
output cap is derived as `cap x conversionEfficiency` (the test above). An
explicit `side: "vehicle"` selects the connector output. **Rejected:** output by
default (it makes a 6 kW "site limit" draw 6.3 kW from the grid on a 95 %
charger).

Below the IEC 61851 minimum current (OpenEMS uses 6 A) a real EVSE pauses.
**Decision for v1:** apply the number as given, including 0, and **do not**
change the OCPP connector status automatically (that would hide an OCPP
`StatusNotification` behind an electrical call, and the issue warns against
it). An opt-in `pauseBelowMinCurrentA` is a follow-up.

### D5. Owners, arbitration, lease and failsafe

- A limit belongs to a `source` (`[a-z0-9._-]{1,64}`, at most 8 per connector).
  A source edits only its own entry; the same source writing again replaces it.
- **Several sources combine by taking the tightest cap** (`min`). That is
  explicit, commutative and order-independent, so there is no last-write-wins
  to lose. **Rejected:** exclusive owner locks (needs handover rules), priorities
  (needs a registry nobody asked for), silent last-write-wins (the issue forbids
  it).
- Every limit has a **lease**: `ttlMs` (default 60 000, maximum 24 h) or an
  absolute `validUntil` in **simulation-clock** epoch ms, not both. At expiry
  the limit **lapses** (the cap is removed) unless it carries `onExpiry:
{ maxPowerW?, maxCurrentA? }`, a fallback cap that then holds until cleared.
  **Rejected defaults:** holding forever (an EMS that died would pin the
  charger and hide the bug), and zero (surprising, and it contradicts the
  issue's "expire the cap and assert recovery").
- A **controller disconnect** (socket closed) changes nothing by itself: the
  lease alone decides. An opt-in `releaseOnDisconnect` per call is a follow-up.
- **Independence from OCPP:** the store is in memory, per connector, and
  neither a WebSocket outage (`network_sim.*`) nor an OCPP `Reset` clears it;
  limits keep applying while the CSMS is unreachable. A `power.loss` suspends
  every electrical quantity as it does today (the station is off) and the
  leases keep running on the simulation clock, so a long outage lets them
  lapse. Limits are **not** persisted across a daemon restart (a lease does
  not outlive its holder); this is documented, not hidden.

### D6. Read model

**Decision:** a versioned snapshot, one per connector, from the same
`OperatingPoint`, plus an optional atomic multi-CP form. No second SoC or meter
pipeline: energy counters are read from the register that MeterValues read.

Fields (all W, A, Wh, V, V/phase, UTC ms; unknown is `null`, never `Infinity`):
`version`, `cpId`, `connectorId`, `at` (simulation ms), `tick` (monotonic
per CP), `state` (`connected`, `ready`, `charging`, `suspended`),
`requestedW` (EV demand), `offeredW`, `deliveredW` (vehicle side),
`gridInputW` (`inputW`), `currentA`, `offeredCurrentA`, `voltageV`, `phases`,
`soc`, `energyImportWh`, `limits[]` (`source`, `maxPowerW`, `maxCurrentA`,
`side`, `validUntil`), `bounds` (`scheduleW`, `chargerW`, `externalW`,
`vehicleW`), `limitedBy[]`.

Event: one `electrical` event on the CP's existing room, emitted on a change of
the limits, of `limitedBy` or of the state, and at most once per second per
connector otherwise (coalesced, latest wins; a slow subscriber loses
intermediate values, never the last one). Privacy: no ids of idTags or
transactions beyond what `status` already shows.

### D7. Time

What is deterministic today, per `docs/concepts/charger-engine.md` and the code:
the engine, behaviors and the energy register run on `SimClock`, and
`VirtualClock.advanceTo` fires timers in a fixed order. The WebSocket
transport still uses real timers (`OCPPWebSocket.ts`: handshake, ping and
reconnect `setTimeout` / `setInterval`), and SOAP paths too; the daemon creates
stations on the real clock (no `VirtualClock` in `apps/cli`). So:

| Mode                                                           | Works today                                                                         | Needs                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Real-time, event stream, eventual updates                      | **Yes**, after stages 1 and 2                                                       | Nothing else                                                                                  |
| Step mode (apply batch, advance to `t`, read barrier snapshot) | Only in-process against a fake CSMS or a trace replay, as the virtual-time runs are | A daemon virtual-clock mode, `electrical.step`, and a rule that no real transport is attached |
| FMI/FMU                                                        | No                                                                                  | Out of scope; a step-mode adapter could later wrap it                                         |

**Decision:** ship real-time first and state plainly that deterministic
co-simulation against a live OCPP WebSocket is not possible. Step semantics to
fix later: one `tickId` per step, inputs applied in `(source, sequence)` order
before the clock moves, `advanceTo` as the barrier, the snapshot carries the
`tickId`, a rejected or timed-out step leaves the clock where it was and the
leases are evaluated on the simulation clock only.

## API sketch (illustrative, do not freeze)

```ts
// packages/contracts: new methods, CP-scoped like set_ev_settings
"electrical.limit.set": {
  cpId, connectorId,                  // connector >= 1
  source: string,                     // owner and lease holder
  maxPowerW?: number, maxCurrentA?: number,   // at least one, finite, >= 0
  side?: "grid" | "vehicle",          // default "grid"
  phaseCount?: 1 | 3,
  ttlMs?: number, validUntil?: number,        // not both; sim-clock ms
  onExpiry?: { maxPowerW?: number, maxCurrentA?: number },
}  // -> { ok: true, effectiveBoundW, limitedBy }  | error
"electrical.limit.clear":   { cpId, connectorId, source }
"electrical.snapshot":      { cpId, connectorId? }  // -> ElectricalSnapshot v1
"electrical.snapshot_many": { cpIds?, labels? }     // atomic across CPs, later
// push: event "electrical" on the cp room (see D6)
// later: "electrical.step": { tickId, advanceToMs, limits[], timeoutMs }
```

Errors reuse the closed set (`invalid_params`, `cp_not_found`, `powered_off`
is **not** returned: a limit may be set while the station is off).
Conflicting writes cannot occur by D5.

## Gap analysis

| Gap                                          | Where                                                                                            | Size                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| New `ExternalTerm` + `limitedBy: "external"` | `OperatingPoint.ts`, `Connector.operatingPoint()`, `ConnectorSnapshot` (`contracts/behavior.ts`) | Small; golden-wire must stay unchanged |
| Limit store with leases on `SimClock`        | new core file beside `PowerSharing.ts`                                                           | Small                                  |
| `electrical.*` methods and docs              | `contracts/methods.ts`, daemon registry, `control-plane.md` (canonical RPC table), MCP           | Medium                                 |
| Snapshot and event                           | contracts + `registryEvents.ts`                                                                  | Medium                                 |
| Min-current pause, phase switching           | `Connector`, `chargerCapabilities`                                                               | Optional                               |
| Step mode                                    | daemon + clock wiring + transport timers                                                         | Large; separate                        |

## Risks

- **Two sources of truth** if a client treats `set_meter_value` or a profile as an
  electrical control: keep the docs explicit and the method names distinct.
- **Golden wire**: any change to default output breaks the fixtures; the term
  must be `Infinity` by default and PR 1 must run the full golden suite.
- **Lease surprises**: a TTL shorter than the controller's period makes the cap
  flap; the default of 60 s and the `limits[]` in the snapshot make it visible.
- **Fleet scale**: reads are cheap (1.2 µs); the risk is event volume, hence
  coalescing and no per-tick push.
- **Real-time only**: a co-simulation that assumes lockstep will see jitter and
  must be told so up front.
- **Licensing**: OpenEMS is AGPL-3.0 (OCPP bundle EPL-2.0); a test harness that
  runs it stays outside this repository and is not a dependency.
- **Scope creep** into an optimizer, site model or OpenADR: out of scope here.

## Staged follow-up proposal (not filed)

1. **feat(core): external electrical limit term** — `ExternalTerm`, store with
   leases and arbitration (D5), `limitedBy: "external"`, unit tests incl. the
   feasibility cases, golden-wire unchanged. _Milestone: Realistic Charging &
   Failure Simulation._
2. **feat(contracts,daemon): `electrical.limit.set|clear` + MCP + docs** —
   wire schemas, errors, `control-plane.md`, CLI JSON mode. Depends on 1.
3. **feat: electrical snapshot v1 and coalesced event** — D6; reuse the single
   `OperatingPoint`; contract test that snapshot, register and MeterValues
   agree. Depends on 1.
4. **test(e2e): CSMS + external controller POC** — the issue's scenario (9 kW
   profile, 6 kW external, demand above both, recover on clear/expiry, controller
   disconnect and WebSocket outage tested independently) with the gocpp CSMS.
   Depends on 2 and 3.
5. **docs/example: OpenEMS-side harness** — a runnable example outside the
   build (Socket.IO bridge from an OpenEMS EVCS/EVSE component, or an OpenEMS
   instance as CSMS plus our limits), versions pinned.
6. **feat(daemon): virtual-clock step mode** — `electrical.step`, barrier
   snapshot, `tickId`, real transports refused (D7). Prerequisite for ACN-Sim
   style lockstep.
7. **example: ACN-Sim adapter** (Python, outside the repo) once 6 exists.
8. **spike/feat: Modbus TCP server adapter** — only with a named consumer's
   register map; check `modbus-serial` under Bun first.
9. **feat: min-current pause and `releaseOnDisconnect`** — opt-in refinements
   from D4 and D5.

## Verified and unverified

Verified here: the code facts above (read from this repository at the commit of
this PR), the five feasibility tests, the 1.2 µs resolver timing, and the
upstream names and versions listed (read through the GitHub API).

**Not verified:** any run of OpenEMS, EVerest, ACN-Sim or pandapower; their
license text beyond what GitHub reports; the Modbus register maps; OCPP
behavior with a CSMS and an external controller together (no POC was built, the
resolver test is the nearest evidence); fleet-scale behavior of events;
`pandapower` integration (speculation); and the exact semantics of `step` on a
daemon.
