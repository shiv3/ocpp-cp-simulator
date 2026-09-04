# Built-in charge point blueprints

The authoritative id → hardware mapping. A **blueprint** is the hardware half
of a charge point (what it _is_); a [scenario](../scenarios/README.md) is the
behaviour half (what it _does_). The two compose: instantiate a blueprint, then
load a scenario onto a connector.

| Id           | Hardware                      | Connectors | Notes                                     |
| ------------ | ----------------------------- | ---------- | ----------------------------------------- |
| `ac-22kw`    | AC 3-phase 22 kW wallbox      | 1          | The commonest European AC unit            |
| `ac-22kw-x2` | AC 3-phase 22 kW, twin outlet | 2          | Two sockets sharing one controller        |
| `dc-50kw`    | DC 50 kW rapid charger        | 2          | CCS + CHAdeMO era hardware                |
| `dc-150kw`   | DC 150 kW high-power charger  | 2          | Where a charging curve is worth modelling |
| `dc-350kw`   | DC 350 kW high-power charger  | 4          | Large site, four outlets                  |

**Read-only.** `blueprint.list` returns these alongside stored ones, and
loading one copies it — the same instance semantics scenario templates use, so
editing an instantiated charge point never mutates the built-in. Saving a
blueprint whose id matches a built-in is refused rather than silently shadowing
it, since `blueprint.delete` could then never restore the original.

`wsUrl` is deliberately absent: a blueprint describes hardware, and the CSMS a
fleet points at is a property of the run. `cp.create_many` requires it
alongside `blueprintId`.
