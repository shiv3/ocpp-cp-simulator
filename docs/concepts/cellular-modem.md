---
title: Cellular modem and SIM
type: concept
summary: An opt-in, stateful modem with one SIM slot owned by a charge point — no modem, empty slot or inserted card, subscription active or suspended, and the network interface the station uses; lifecycle through `modem.command`, masked in every read surface, persisted with the state database.
sources:
  - packages/core/src/cp/domain/modem/CellularModem.ts (state machine, validation, masking)
  - packages/core/src/cp/domain/modem/modemCommands.ts
  - packages/core/src/cp/infrastructure/persistence/SqliteModemRepository.ts
  - packages/contracts/src/modem.ts
  - apps/cli/src/server/__tests__/modemRpc.bun.test.ts
  - "issue #928"
related:
  - network-simulation.md
  - control-plane.md
  - state-persistence.md
  - ../entities/mcp-endpoint.md
  - ocpp-versions-and-transports.md
updated: 2026-11-14
---

# Cellular modem and SIM

A charge point can carry a small model of a **cellular modem with one SIM
slot** (#928). It is **opt-in**: a station created without `modem` has no model,
its BootNotification keeps the static `bootNotification.iccid` / `imsi` it
always had, and no status field, log line or wire byte changes. The model owns
_what is physically there_; whether a link works is a separate question (see
[Network simulation](network-simulation.md)). **A SIM being present does not
imply working connectivity**, and a SIM does not disconnect a station that
reaches its CSMS over another interface.

## State

| Part                  | Values                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `slot`                | `no_modem` (the station has no modem), `empty` (modem, no card), `inserted`                                                    |
| `sim` (when inserted) | `simId` (simulator-owned, `<cpId>-sim-<n>`, new for every inserted card), optional `iccid`, `imsi`, `operator`, `subscription` |
| `subscription`        | `active` (default) or `suspended`. A removed card is **no card**, never a suspended one                                        |
| `networkInterface`    | `ethernet` (default), `wifi` or `cellular`                                                                                     |

A station without any model is a fourth, distinct case: `modem` is absent from
its status and every `modem.*` call answers `no_modem_model`.

A suspended SIM stays in the slot and **keeps its ICCID and IMSI**; only
`subscription` changes. One modem and one slot: no multi-SIM, no eSIM profile
switching.

## Configuration

`modem` in `cp.create` (and so in blueprints and fleet templates — each charge
point gets its own copy, a shared template object is never mutated):

```json
{
  "modem": {
    "present": true,
    "networkInterface": "cellular",
    "sim": {
      "iccid": "8944501234567890123",
      "imsi": "310150123456789",
      "operator": "acme",
      "subscription": "active"
    }
  }
}
```

`present: false` is a station without a modem; `sim` omitted or `null` is an
empty slot. `iccid` / `imsi` are 1-20 printable characters without spaces (the
OCPP BootNotification limit); `operator` is a label of 1-64 printable
characters. Anything else is `invalid_params`.

**Initial state only.** The configuration seeds the model when nothing is
persisted for the charge point id. Once persisted, the persisted state wins, so
`cp.update` (which rebuilds the charge point) never gives a swapped card back;
change the state with the commands below.

## Commands

`modem.get { cpId }` returns `{ ok: true, modem }`. `modem.command` takes
`{ cpId, command, … }`:

| `command`               | Extra params       | Refused with                                      |
| ----------------------- | ------------------ | ------------------------------------------------- |
| `insert_sim`            | `sim`              | `modem_absent`, `slot_occupied`, `invalid_sim`    |
| `remove_sim`            | —                  | `modem_absent`, `slot_empty`                      |
| `replace_sim`           | `sim`              | `modem_absent`, `slot_empty`, `invalid_sim`       |
| `suspend_subscription`  | —                  | `modem_absent`, `slot_empty`, `already_suspended` |
| `activate_subscription` | —                  | `modem_absent`, `slot_empty`, `already_active`    |
| `set_network_interface` | `networkInterface` | `invalid_network_interface`                       |
| `set_reporting_policy`  | `reporting`        | `invalid_reporting_policy`                        |

The answer is `{ ok: true, modem }` or `{ ok: false, error }`; a refused command
leaves the state untouched (`cp_not_found` and `no_modem_model` also appear).
The MCP tools are `modem_get` and `modem_command`
([MCP endpoint](../entities/mcp-endpoint.md)). The commands work without
recreating the charge point, and change nothing on the OCPP connection by
themselves. `replace_sim` creates a new `simId`.

## Link state (#930)

`modem.get` and the status wire carry `link` beside the card:
`networkInterface`, `available`, `reasons`, the effective byte caps and the
policies that select the card. A **suspended card does not by itself disconnect
anything unless the station's interface is `cellular`**; on a cellular station
the link is held down until the subscription is active and no policy blocks it.
The gate, the SIM-scoped policies and the throttling are described in
[Network simulation](network-simulation.md#sim-scoped-service-and-throttling-930).

## BootNotification identifiers (#929)

With a modem model, **the installed SIM is the single source of truth** for
the modem identifiers of the BootNotification. It is read from one projection
(`bootPayload()` in the charge point, `projectBootIdentifiers` in
`packages/core/src/cp/domain/modem/bootIdentifiers.ts`) at the moment the
message is prepared, whatever triggers it (cold boot, Reset, `TriggerMessage`,
firmware update, a reconnect that boots).

| `reporting` (default `iccid-and-imsi`) | Reported of the card                             |
| -------------------------------------- | ------------------------------------------------ |
| `none`                                 | nothing                                          |
| `iccid`                                | the ICCID                                        |
| `iccid-and-imsi`                       | the ICCID and the IMSI (each if the card has it) |

- **Where they go.** OCPP 1.6 JSON and SOAP: the optional top-level `iccid` /
  `imsi`. OCPP 2.0.1 / 2.1: `chargingStation.modem.iccid` / `.imsi`. No
  nonstandard field is added.
- **Omitted, never faked.** No modem, an empty slot, policy `none` or an
  identifier the card lacks: the field is left out entirely (in SIM-backed mode
  a 1.6 BootNotification has no `iccid` / `imsi` keys, not empty strings; a 2.x
  one has no `modem` object). No placeholder is invented.
- **Precedence.** The static `bootNotification.iccid` / `imsi` apply **only
  without a modem model**; with one they are ignored (not merged), so there is
  never a second writable source. Without a model the payload is the same
  object as before: the 1.6 empty strings and every golden fixture stay
  byte-identical.
- **Subscription state is not coupled to reporting**: a suspended card keeps
  its identifiers and keeps reporting them.
- **Changes take effect at the next boot, never cause one.** Insert, remove,
  replace and policy changes alter the _next_ BootNotification (real or
  triggered). They do not reboot the station, do not send a BootNotification,
  and a reconnect alone does not either. On OCPP 2.x a pure reconnect still
  follows #702: it resumes without a BootNotification while the boot data is
  unchanged, and sends one when the projected data changed (a swap; a
  subscription change does not change it); the `BootOnReconnect` switch keeps
  its meaning. OCPP 1.6 sends a BootNotification on every connect, as before.

## Privacy policy for ICCID / IMSI

ICCID and IMSI identify a subscriber and some deployments regulate them.
**Every read surface shows them masked to their last four characters** (all
`*` when four or fewer): `cp.status` / the `modem` block of the status wire,
`modem.get`, `modem.command` answers, the MCP tools and the log lines
(`SIM inserted: … (iccid ***************0123, active)`). The full values leave
the simulator in one place only, the BootNotification the reporting policy allows. They are never in `cp.list`, the operational timeline or
the redacted diagnostics.

## Persistence

With a state database the model is stored in the `kv` row `modem:<cpId>` after
every change, so a station restart or a daemon restart keeps the card, its
subscription state and the selected interface; a restored charge point finds it
even though its stored init has no `modem`. Deleting the charge point deletes
the row. A corrupt row is ignored. **Without a state database** (`:memory:`
daemon, tests, the single-CP CLI) a restart starts again from the configured
initial state.

## Where it runs

The model is part of the charge-point domain, so the daemon and the browser's
Local mode share one implementation. The Local-mode service exposes the same
`getModem` / `modemCommand` calls; the web console shows no SIM editor yet (the
status carries the masked state for it).
