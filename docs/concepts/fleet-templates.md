---
title: Fleet templates
type: concept
summary: One persisted definition of a heterogeneous fleet — groups of charge points, each line naming a blueprint, scenario template, EV settings, network simulation, labels and field overrides — shared by `--fleet-template` files and the state database, instantiated by `fleet.create`.
sources:
  - packages/contracts/src/methods.ts (fleetTemplateSchema, fleetCreateParamsSchema)
  - apps/cli/src/server/socketServer.ts (planFleet, createFleet)
  - apps/cli/src/server/fleetTemplateFiles.ts
  - packages/core/src/cp/domain/persistence/FleetTemplateRepository.ts
  - apps/cli/src/server/__tests__/fleetTemplates.bun.test.ts
  - docs/examples/fleet-templates/operations-lab.json
  - "issue #445"
related:
  - control-plane.md
  - state-persistence.md
  - network-simulation.md
  - scenario-format.md
  - ../entities/scenario-templates.md
  - ../entities/daemon.md
  - ../entities/mcp-endpoint.md
  - ../analyses/fleet-load-and-observability-roadmap.md
updated: 2026-11-08
---

# Fleet templates

`cp.create_many` makes many _similar_ charge points. A **fleet template**
describes a _heterogeneous_ fleet — different blueprints, startup scenarios,
network simulation, EV settings and labels per charge point — as one reusable
unit (#445). It composes the existing building blocks by id
([blueprints](control-plane.md#blueprints), [scenario templates](../entities/scenario-templates.md),
[network simulation](network-simulation.md)) and owns no hardware or scenario
definition of its own.

One schema serves both ways of holding a template (decision D09):
`fleetTemplateSchema` in `packages/contracts`. A `--fleet-template` file, a
`fleet.template.save` call and a row of the `fleet_templates` table are all the
same JSON.

## Shape

```json
{
  "id": "operations-lab",
  "name": "Operations lab",
  "labels": { "env": "lab" },
  "groups": [
    {
      "name": "site-a",
      "labels": { "site": "a" },
      "members": [
        { "cpId": "CP001", "blueprintId": "ac-22kw" },
        {
          "cpId": "CP002",
          "blueprintId": "ac-22kw",
          "scenarioTemplateId": "full-charging-cycle"
        }
      ]
    },
    {
      "name": "site-b",
      "members": [
        {
          "idPattern": "DC{n:03}",
          "count": 2,
          "startIndex": 4,
          "blueprintId": "dc-150kw",
          "evSettings": { "maxChargingPowerKw": 60 }
        }
      ]
    }
  ]
}
```

A complete example is [`docs/examples/fleet-templates/operations-lab.json`](../examples/fleet-templates/operations-lab.json).

| Level    | Field                                                 | Meaning                                                                                                                                              |
| -------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| template | `id`, `name`, `description?`                          | Identity. `id` is unique across stored and file templates.                                                                                           |
| template | `labels?`                                             | Labels for every charge point.                                                                                                                       |
| template | `groups` (≥ 1)                                        | Named sets of members; names are unique within the template. A group has `name`, `labels?` and `members` (≥ 1).                                      |
| member   | `cpId` **or** `idPattern` + `count` (+ `startIndex?`) | One charge point, or a range expanded like `cp.create_many` (`{n}`, `{n:03}`; `count` ≤ 200; `startIndex` defaults to 1). Exactly one of the forms.  |
| member   | `blueprintId`                                         | Required. A built-in or stored blueprint.                                                                                                            |
| member   | `scenarioTemplateId?`, `evSettings?`                  | Replace the blueprint's own for this line; absent: the blueprint's apply.                                                                            |
| member   | `networkSimulation?`                                  | A per-charge-point layer, as `network_sim.cp.save` takes it.                                                                                         |
| member   | `labels?`                                             | Added to this line.                                                                                                                                  |
| member   | `overrides?`                                          | `cp.create` fields (`vendor`, `model`, `connectors`, `ocppVersion`, `wsUrl`, `autoConnect`, …) replacing the blueprint's for this line. No `labels`. |

A template stands for at most 1000 charge points, ranges expanded, and the
daemon loads at most 1000 templates from `--fleet-template` files. Labels merge
blueprint → template → group → member, later keys winning; the result must
still satisfy the [label limits](control-plane.md#charge-point-labels).

## Methods

| Method                  | Params                                            | Result                                        |
| ----------------------- | ------------------------------------------------- | --------------------------------------------- |
| `fleet.template.list`   | `{}`                                              | File templates and stored ones, by id         |
| `fleet.template.get`    | `{ id }`                                          | The template; `not_found` otherwise           |
| `fleet.template.save`   | `{ template }`                                    | `{ id }`                                      |
| `fleet.template.delete` | `{ id }`                                          | `{ ok: true }`; `not_found` for an unknown id |
| `fleet.create`          | `{ templateId, wsUrl?, idPrefix?, autoConnect? }` | `{ templateId, created, failed }`             |

MCP tools: `fleet_template_list`, `fleet_template_get`, `fleet_template_save`,
`fleet_template_delete`, `fleet_create` ([MCP endpoint](../entities/mcp-endpoint.md)).
The web console has no fleet-template screen yet; it is split out of #445.

## Instantiation

`fleet.create` resolves the whole template first and creates second.

1. **Resolve, with no side effect.** Every member's blueprint and scenario
   template must exist (`not_found`), every merged parameter block must be a
   valid `cp.create` (`invalid_params`), every `networkSimulation` must be a
   valid layer config (`invalid_params`; `fleet.template.save` and the
   `--fleet-template` loader refuse the same template up front), an expanded
   `soapCallbackUrl` must stay within 2048 characters, the labels must fit, and
   no charge point id may appear twice in the template (`invalid_params`). Any
   failure here fails the call and creates nothing.
2. **Create in template order**: groups in order, members in order, a range
   ascending. Each charge point goes through the same path as `cp.create_many`.
   Then, per connector, the line's (else the blueprint's) EV settings and
   scenario template are applied, then the network simulation layer, and only
   then — when `autoConnect` is on — the charge point connects, so it never
   dials half-configured.
3. **Report.** `created` and `failed` (`{ cpId, reason }`) are in template
   order and identical on every run against the same state. A charge point that
   cannot be created (an id already registered, say) or configured is rolled
   back and listed in `failed`; the others stay. As with `cp.create_many`, a
   partial batch is a normal result, not an error.

   Creation is sequential, so a large template can outlast the 30 s control-plane
   deadline: the call then answers `timeout` while the daemon keeps creating.
   After a `timeout`, list the fleet with `cp.list`
   instead of retrying `fleet.create`, which would report every created id as
   already registered.

`wsUrl` precedence, highest first: the member's `overrides.wsUrl`, the call's
`wsUrl`, the blueprint's own. Without any of them the call fails
`invalid_params`. `autoConnect` precedence: the member's `overrides.autoConnect`,
the call's, the blueprint's own, then off, so a caller's explicit
`autoConnect: false` beats what a blueprint saved. `idPrefix` is prepended to
every id, so one template can be instantiated more than once (`a-CP001`,
`b-CP001`). A member with a `soapCallbackUrl` cannot be combined with
`idPrefix`: the prefixed id no longer matches the id inside the callback URL
(only the index is expanded), so the call fails `invalid_params`.

Instances are independent: `fleet.create` copies what it resolved, nothing links
a charge point back to its template, and editing or deleting a template never
touches a fleet that is already running. Blueprints are likewise not mutated: a
line's overrides apply to its charge points only.

## Persistence and files

- With `--state-db` templates live in the `fleet_templates` table (schema v27)
  and survive a restart; without it the repository keeps them in memory, like
  [blueprints](state-persistence.md). A stored row that no longer matches the
  schema is skipped, not fatal.
- `--fleet-template <file>` (repeatable, server modes only) loads a file at
  startup: one template, or an array of them, in exactly the stored shape. An
  unreadable file, invalid JSON, a schema violation or an id defined by two files
  exits 1, naming the file and the offending path. These templates are
  **read-only**: they are listed and instantiated like any other, win over a
  stored template with the same id, and `fleet.template.save` /
  `fleet.template.delete` refuse their ids (`invalid_params`). Edit the file and
  restart.
- A template saved over the control plane may name a blueprint or scenario
  template that does not exist yet; that is reported by `fleet.create`, not by
  `fleet.template.save`.
