---
title: Vehicle profiles
type: concept
summary: Reusable, locally saved vehicle descriptions (specs, DC curve, local edits, provenance) imported from Open EV Directory and copied into EV settings when applied — the model, its resolution to EVSettings, refresh, storage and open points.
sources:
  - src/cp/domain/vehicle/VehicleProfile.ts
  - src/cp/domain/vehicle/importProfile.ts
  - src/cp/domain/vehicle/VehicleCatalog.ts
  - src/cp/domain/persistence/VehicleProfileRepository.ts
  - src/protocol/vehicle.ts
  - src/components/vehicle/vehicleChoice.ts
  - "issue #458"
  - "issue #327"
  - "issue #311"
related:
  - ../entities/open-ev-directory.md
  - ../entities/web-console.md
  - control-plane.md
  - state-persistence.md
  - scenario-format.md
  - local-vs-remote-mode.md
  - ../entities/daemon.md
  - ../entities/mcp-endpoint.md
  - ../sources/github-issues.md
updated: 2026-10-11
---

# Vehicle profiles

A **vehicle profile** is a reusable description of a car — battery, AC and DC
power, connectors, a DC charging curve — saved locally and offered in every
vehicle select of the [web console](../entities/web-console.md) (#458). It
describes the vehicle, not a charging session: a connector, the default EV
settings or a scenario take a **copy** of it as
[EV settings](scenario-format.md#charging-curve-v12) when you pick it. Profiles
are imported from [Open EV Directory](../entities/open-ev-directory.md), then
edited locally. The domain lives in
[`src/cp/domain/vehicle/`](../../src/cp/domain/vehicle/); the RPC methods are
in [Control plane → Vehicle profiles and catalog](control-plane.md#vehicle-profiles-and-catalog).

## The model

[`VehicleProfile.ts`](../../src/cp/domain/vehicle/VehicleProfile.ts):

| Field                    | Meaning                                                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`             | `name` is the display name and becomes `EVSettings.modelName` when the profile is applied.                                                                                                                       |
| `specs`                  | What the chosen source record says: `usableBatteryKwh`, `acMaxKw`, `acPhases`, `dcMaxKw` (each `null` when the source does not give it) and `acConnectors` / `dcConnectors` (OCPI 2.3.0 `ConnectorType` values). |
| `dcCurve`                | The DC curve as published: `{ socPercent, powerKw }[]` in **kW** and in source order, or `null`. Kept in kW so a later change of the DC maximum does not rescale it.                                             |
| `overrides`              | Your local edits of the four numeric specs. They win over `specs` and survive a refresh.                                                                                                                         |
| `origin`                 | Provenance, `null` for a hand-made profile (the console has no form to create one; the type allows it).                                                                                                          |
| `createdAt`, `updatedAt` | ISO timestamps.                                                                                                                                                                                                  |

`origin` carries `provider: "open-ev-directory"`, the `variantId`, the make /
model / variant names, the `sourceId` and immutable `sourceRecordKey`
(`<sourceId>:<externalId>`) whose specs were kept, `sourceUrl`, the `curveId`
and the curve's own `curveSourceId` (it may differ from the specs' source),
`curveQuality` (`MEASURED`, `DERIVED`, `ESTIMATED` or `UNKNOWN` — never
overstated), `qualityBasis`, `observations`, `datasetVersion`, the
`licenses` (with their attribution text), `importedAt` and, after a refresh
found the variant gone, `removedUpstream: true`.

## Resolution to EV settings

`resolveEvSettings(profile, "AC" | "DC")` turns the profile — `specs` with
`overrides` applied — into the part of `EVSettings` a vehicle determines:
`modelName`, `batteryCapacityKwh`, `maxChargingPowerKw`, `chargingCurve`,
`currentType` and `phases`. A profile is offered once per current type in the
selects, because the same car charges differently on AC and DC.

- **DC.** `maxChargingPowerKw` is `max(dcMaxKw, curve peak)`, and the curve
  becomes `powerFraction`s of that maximum. A source can publish a curve that
  peaks above its own DC maximum; dividing by the declared maximum would give
  fractions above 1, which the curve normalization silently drops, so the
  peak wins and a warning says why. A curve's peak also stands in for a
  missing `dcMaxKw`. Without a curve the vehicle charges flat at its maximum.
- **AC.** `maxChargingPowerKw` is `acMaxKw`; `phases` is set only for 1 or
  3 (what the simulator models). There is no AC curve: Open EV Directory's
  curves are DC only.

The resolution never invents the values that size a session: a profile with
no usable battery capacity, or no maximum power for the requested current
type (`acMaxKw` for AC; `dcMaxKw` or a curve for DC), fails with
`missing_fields` and names them — a car without a known capacity is not a
75 kWh car. The console lists that current type **disabled** with what is
missing. A DC curve with a point outside 0–100 % SoC or below 0 kW fails with
`invalid_curve`. An unknown or unsupported AC phase count is the only value
filled by an assumption: `phases: 1`, and a warning says so.

A successful resolution returns warnings, which the console shows under the
select (`describeWarning` in
[`vehicleChoice.ts`](../../src/components/vehicle/vehicleChoice.ts)):

| Warning                       | When                                        | Effect                                                      |
| ----------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `POWER_ABOVE_DC_MAX`          | DC curve peaks above the declared `dcMaxKw` | `maxChargingPowerKw` is the curve peak, so no point is lost |
| `CURVE_STARTS_ABOVE_ZERO_SOC` | First curve point is above 0 % SoC          | Below it the first power is held; nothing is extrapolated   |
| `CURVE_ENDS_BELOW_FULL_SOC`   | Last curve point is below 100 % SoC         | Above it the last power is held; nothing is extrapolated    |
| `NO_DC_CURVE`                 | DC with no curve                            | Flat acceptance at the maximum power                        |
| `UNSUPPORTED_AC_PHASES`       | AC phase count other than 1 or 3            | `phases: 1` (single phase)                                  |
| `AC_PHASES_UNKNOWN`           | AC phase count missing                      | `phases: 1` (single phase)                                  |

The hold at either end of the curve is the simulator's normal
[curve clamping](scenario-format.md#charging-curve-v12), not something the
resolution adds.

`applyVehicleSettings(base, vehicle)` puts the result onto existing settings:
the session's SoCs and the electrical values a vehicle does not determine
(`voltageV`, `powerFactor`) are kept. A vehicle without a curve resolves to an
**explicit** empty curve (`chargingCurve: []`, flat acceptance), and an AC
vehicle to an explicit `phases`, never to absent keys: the connector and a
scenario start _merge_ settings into the current ones
(`Connector.applyEvSettingsOverride`), so an absent key would keep the previous
vehicle's curve or phases. A DC resolution does not set `phases`, which DC
ignores. The connector Config dialog keeps Battery and Max power editable after a
pick; its curve, current type and phases come from the profile.

## Snapshot, not reference — the offline guarantee

Applying a profile copies its values into the connector's EV settings, the
Default EV Settings or the scenario's `evSettings`. Nothing at run time reads
a profile or the catalog: a simulation, a scenario run or a restart works the
same with the catalog unreachable, the key revoked or the profile deleted
(`importedProfileOffline.test.ts`). Editing or refreshing a profile does not
change what was applied before; pick it again to take the new values.

## Import

`profileFromCatalog(variant, selection)` in
[`importProfile.ts`](../../src/cp/domain/vehicle/importProfile.ts) builds a
profile from a catalog variant and two **explicit** choices: the source record
whose specs to keep and the curve to import, or no curve. The catalog keeps
sources side by side and never consolidates them, and the simulator never
picks a "best" record or curve on your behalf; the console preselects
neither. The name defaults to `<make> <variant>`. A missing value stays
`null` in `specs`; what you fill in during the import is stored as an
override.

## Refresh

`refreshFromCatalog(profile, variant)` re-reads the **same** source record and
curve from a fresh copy of the variant and lists the changes (each spec field,
the curve, and every provenance field but the import time — the variant id,
the dataset version, the curve quality and its basis, the observations, the
licenses and their attribution) before anything is saved. It
replaces only the imported values: the name, `overrides` and `createdAt` are
kept, so a refresh never loses a local edit. When the catalog has renamed the
variant (a former id redirects), the new id is followed and listed as a
change. The console shows the differences and asks **Replace the imported
values?** before saving.

When the catalog answers `not_found` for the variant, `markRemovedUpstream`
flags the profile (`origin.removedUpstream`) and keeps every value; it stays
usable and the console marks it _no longer in the catalog_, still offering
**Refresh**: a refresh that finds the variant again lists _back in the
catalog_ as a change, even when nothing else differs, and **Replace** clears
the flag. When the variant
still exists but the imported source record or curve does not, the refresh
fails and the profile is left untouched (not flagged). Any other failure —
key refused, rate limit, timeout, network — also leaves the profile as it
was.

## Storage and reset

Profiles are stored in the `vehicle_profiles` table (schema version 15,
[State persistence](state-persistence.md#tables)): in the daemon's
`--state-db` in Remote mode, in the browser's sql.js database in Local mode.
Without `--state-db` the daemon keeps them in memory for the life of the
process. Each row is validated by `vehicleProfileSchema`
([`src/protocol/vehicle.ts`](../../src/protocol/vehicle.ts)) on save and on
read; a stored row that no longer matches is skipped rather than hiding every
other profile. A curve holds at most 512 points, and each store (the daemon's
and the browser's) holds at most 1,000 profiles: a new one past the cap is
refused (`vehicle_profiles.save` answers `invalid_params`), replacing an
existing one is not. A profile never contains an API key.

`state.reset` and the console's **Reset all simulator data** wipe the profiles —
the in-memory store too, when there is no database —
with everything else — a deliberate decision (`resetOnStateReset: true`): a
reset means a clean simulator. `cp.delete` never touches them; they belong to
no charge point.

## Relation to #311 and #327

#311 asked for a reusable `VehicleProfile` shared by the traffic generator
and MeterValues, and was folded into #327 (one resolved operating point per
tick, from one vehicle profile). This profile is that reusable vehicle object:
it resolves to `EVSettings`, which every existing consumer already reads. The
#327 refactor — one operating point computed per tick for accumulation,
reporting and background traffic — is **not** part of #458; when it lands it
should consume `VehicleProfile` / `resolveEvSettings` rather than add a
second vehicle model.

## Licensing and attribution

Imported specs and curves come from third-party datasets under their own
terms, which Open EV Directory states per record: EVDB (Gaia) under
**CC BY-SA 4.0** and Open EV Data (KilowattApp) under the **MIT License with
Attribution Requirement** (see the
[fixture LICENSE](../../src/cp/infrastructure/vehicle-catalog/open-ev-directory/__fixtures__/LICENSE.md)).
A profile keeps each license with its attribution text in `origin.licenses`
(the specs' source and, when different, the curve's), and the console shows
it under **Attribution** on each profile and before the import is saved.

## Open points

- **Browser-only mode and CORS.** The public instance
  (<https://evdb.juherr.dev>, the default) sends no CORS headers, so a direct
  import from a Local-mode page is refused by the browser and explained;
  import through the daemon instead
  ([Open EV Directory → CORS](../entities/open-ev-directory.md#cors)).
- **Attribution in scenario exports.** A scenario whose EV settings were
  filled from a profile carries the copied curve — Gaia-derived values under
  CC BY-SA — but no attribution. Not decided.
- **No live sync in Remote mode.** The profile list is read when a console
  first shows it and re-read after each save or delete from that console;
  there is no event push, so another browser's change appears on reload.
- **Refresh after removal.** Once a profile is flagged _no longer in the
  catalog_, the console no longer offers **Refresh** for it, even if the
  variant reappears.
