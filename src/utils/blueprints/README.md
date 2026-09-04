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

## `wsUrl` precedence

`wsUrl` is **optional on a blueprint** and required by the time a charge point
is created. A blueprint describes hardware; the CSMS a fleet points at is a
property of the run, so none of the built-ins carry one.

Precedence, highest first:

1. a `wsUrl` passed to `cp.create_many` alongside `blueprintId`;
2. the blueprint's own `params.wsUrl`, if it has one;
3. otherwise the call fails `invalid_params` — the merged parameters are
   validated against `cp.create_many`'s own schema, so a blueprint without a
   URL cannot produce a charge point without one.

`idPattern` is optional for a blueprint batch and defaults to
`<blueprintId>-{n:03}`.
