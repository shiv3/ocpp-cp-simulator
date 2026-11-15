# Dev "all-scenarios" fixture

A declarative set of 13 simulated charge points (48 connectors) for the
always-on dev simulator daemon, so anyone can run **any shipped OCPP 1.6J
scenario template** against the dev central system at any time.

- `fixtures.json`: the source of truth (charge points, connectors, templates).
- `apply.ts`: idempotent applier (Bun + socket.io-client) for a running daemon.
- `gen-db-spec.ts` -> `db-spec.json`: the charging ports to register in the
  dev database (`cpId`, `connectors`, `chargerType` 1 = quick DC / 11 = normal
  AC, `maxPowerKw`, `vendor`, `model`). Regenerate with
  `bun scripts/dev-fixtures/gen-db-spec.ts` after editing `fixtures.json`.

CP ids are `shiv3-sc-<role>`, WebSocket URL is
`wss://cs-k8s.dev-dmm-ev-charge.com/chargepoint/<cpId>`, OCPP 1.6J.
Every CP carries the labels `managed-by=dev-fixtures`, `fixture=all-scenarios`
and `group=<general|cert|resilience|negative>`.

## How scenarios are loaded

- Every connector of every CP runs `essential-cp-behavior` as its **only
  enabled** scenario (auto-starts on connect, waits for RemoteStart, runs a
  session, plugs out): the CP behaves like a well-mannered charger.
- All other templates are loaded **disabled** (`enabled: false`) under the
  stable id `<templateId>-c<connector>`: the auto-start walker skips them at
  every connect, so nothing runs by itself, and they survive a restart.
- The daemon's `load_scenario_template` RPC has no `enabled` parameter (and
  many templates start on `connect`), so `apply.ts` builds the instance from the
  template registry of this repository (`getTemplateById(id).createScenario`),
  sets `id` and `enabled:false` and sends it with `load_scenario`. Same ids and
  contents as `load_scenario_template`, minus the auto-arm. Consequence: the
  checkout you run `apply.ts` from should be the same release as the daemon;
  a template id the daemon does not list in `scenario.templates` is reported
  and skipped (non-zero exit).
- Several disabled scenarios on one connector are fine: ids differ per
  template, and a disabled scenario is never an auto-start candidate, so there
  is no "already running" collision. Only run **one scenario per connector at
  a time** (they drive the same connector), and not on a connector in use.
- No scenario is listed twice: each template sits on exactly one CP/connector.

## Run a scenario on demand

Web console: charge point -> connector -> Scenarios -> Run. Or RPC
(Socket.IO `rpc` event):

```js
// run the loaded (disabled) instance once; it stays disabled afterwards
{ cpId: "shiv3-sc-fault-negative", method: "run_scenario",
  params: { connector: 1, scenarioId: "cert16-tc024-lock-failure-c1" } }
```

Do not use `run_scenario_template` on these: it reloads the instance _enabled_
and re-arming on every connect (pass `once: true` to keep it a single run). If
that happens `apply.ts` puts it back (it skips a scenario that is still
running; stop it first with `stop_scenario`, then re-apply).

Some scenarios need the CSMS side to act (RemoteStart, ReserveNow,
SendLocalList, SetChargingProfile, UpdateFirmware, ...): they park until the
CSMS sends the call. `cert16-tc023-*` and `resilience-authorization-rejected`
need idTags `CERT023-INV` / `CERT023-EXP` / `CERT023-BLK` / `RESIL-BLK` to be
invalid / expired / blocked on the CSMS. `cert16-tc042-1` / `cert16-tc043-1`
switch the local list off through configuration (persisted override). The
`resilience-*` ones are operator-driven: use `network_sim.*` (delay,
disconnect, flapping), `power.loss` / `power.restore`, `modem.command`
(cellular) and `ChangeAvailability` as described in each scenario. Network /
power / modem / vehicle-profile / behavior features are RPCs, not templates, so
they are not part of the fixture state (the fixture keeps CPs well-mannered).

## CPs and scenarios

| cpId                          | role                                                                                                                                                                    | connectors | type    | kW  | scenarios    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------- | --- | ------------ |
| `shiv3-sc-ac-basic`           | Normal AC charger (7.4 kW): plain charging-cycle demos                                                                                                                  | 2          | AC (11) | 7.4 | 4 + baseline |
| `shiv3-sc-dc-quick`           | Quick DC charger (50 kW): data-flow showcase scenarios (branching on answers, CALLERROR handling, charge-to-SoC)                                                        | 2          | DC (1)  | 50  | 4 + baseline |
| `shiv3-sc-multi-connector`    | Multi-connector AC charger (6 x 22 kW): sessions on several connectors, parallel and status-triggered scenarios                                                         | 6          | AC (11) | 22  | 6 + baseline |
| `shiv3-sc-cert-config`        | Certification-style: boot, GetConfiguration/ChangeConfiguration, ClearCache, DataTransfer, OCTT strictness                                                              | 4          | AC (11) | 7.4 | 7 + baseline |
| `shiv3-sc-remote-control`     | Remote start / stop / unlock / TriggerMessage driven by the CSMS                                                                                                        | 6          | AC (11) | 11  | 6 + baseline |
| `shiv3-sc-reboot-power`       | Reset / reboot and power loss: HardReset, SoftReset, power-loss recovery                                                                                                | 3          | AC (11) | 7.4 | 3 + baseline |
| `shiv3-sc-network-resilience` | Network and availability faults: communication loss (network_sim / disconnect / flapping), ChangeAvailability, EV unplug; also the CP to try cellular modem commands on | 3          | AC (11) | 7.4 | 3 + baseline |
| `shiv3-sc-fault-negative`     | Faults and negative behavior: lock failure, refused RemoteStart/RemoteStop/TriggerMessage, unknown connector, connector fault                                           | 6          | AC (11) | 7.4 | 6 + baseline |
| `shiv3-sc-auth-outcomes`      | Authorization outcomes: Invalid / Expired / Blocked idTags (needs matching idTags on the CSMS)                                                                          | 4          | AC (11) | 7.4 | 4 + baseline |
| `shiv3-sc-reservation`        | Reservations: ReserveNow (all outcomes), CancelReservation                                                                                                              | 4          | AC (11) | 7.4 | 7 + baseline |
| `shiv3-sc-local-list`         | Local authorization list: GetLocalListVersion / SendLocalList (full, differential, failed, not supported)                                                               | 2          | AC (11) | 7.4 | 6 + baseline |
| `shiv3-sc-smart-charging`     | Smart charging / charging profiles: TxDefault, TxProfile, RemoteStart with profile, composite schedule, clear profile                                                   | 4          | AC (11) | 22  | 5 + baseline |
| `shiv3-sc-firmware-diag`      | Firmware update and diagnostics: success, download failed, install failed, GetDiagnostics                                                                               | 2          | AC (11) | 7.4 | 4 + baseline |

| CP                            | connector | disabled templates (loaded, not running)                                                                                                       |
| ----------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `shiv3-sc-ac-basic`           | 1         | `full-charging-cycle`, `smart-charging`                                                                                                        |
| `shiv3-sc-ac-basic`           | 2         | `remote-start-auto-meter`, `remote-start-timeout-fallback`                                                                                     |
| `shiv3-sc-dc-quick`           | 1         | `dataflow-authorize-branch-16`, `dataflow-charge-to-soc`                                                                                       |
| `shiv3-sc-dc-quick`           | 2         | `dataflow-remote-start-reauthorize-16`, `dataflow-call-error-handling`                                                                         |
| `shiv3-sc-multi-connector`    | 1         | `cert16-tc003-charging-plugin-first`                                                                                                           |
| `shiv3-sc-multi-connector`    | 2         | `cert16-tc004-charging-id-first`                                                                                                               |
| `shiv3-sc-multi-connector`    | 3         | `cert16-tc005-ev-side-disconnect`                                                                                                              |
| `shiv3-sc-multi-connector`    | 4         | `multi-status-monitor`                                                                                                                         |
| `shiv3-sc-multi-connector`    | 5         | `parallel-heartbeat-session`                                                                                                                   |
| `shiv3-sc-multi-connector`    | 6         | `status-triggered-actions`                                                                                                                     |
| `shiv3-sc-cert-config`        | 1         | `cert16-tc001-cold-boot`, `cert16-tc061-clear-cache`                                                                                           |
| `shiv3-sc-cert-config`        | 2         | `cert16-tc019-get-configuration-all`, `cert16-tc019-get-configuration-key`                                                                     |
| `shiv3-sc-cert-config`        | 3         | `cert16-tc021-change-configuration`, `cert16-octt-strictness-probe`                                                                            |
| `shiv3-sc-cert-config`        | 4         | `cert16-tc064-data-transfer`                                                                                                                   |
| `shiv3-sc-remote-control`     | 1         | `cert16-tc010-remote-start`                                                                                                                    |
| `shiv3-sc-remote-control`     | 2         | `cert16-tc011-remote-start-stop`                                                                                                               |
| `shiv3-sc-remote-control`     | 3         | `cert16-tc012-remote-stop`                                                                                                                     |
| `shiv3-sc-remote-control`     | 4         | `cert16-tc017-unlock-occupied`                                                                                                                 |
| `shiv3-sc-remote-control`     | 5         | `cert16-tc018-unlock-failure`                                                                                                                  |
| `shiv3-sc-remote-control`     | 6         | `cert16-tc054-trigger-message`                                                                                                                 |
| `shiv3-sc-reboot-power`       | 1         | `cert16-tc013-hard-reset`                                                                                                                      |
| `shiv3-sc-reboot-power`       | 2         | `cert16-tc014-soft-reset`                                                                                                                      |
| `shiv3-sc-reboot-power`       | 3         | `resilience-power-loss-recovery`                                                                                                               |
| `shiv3-sc-network-resilience` | 1         | `resilience-communication-loss-recovery`                                                                                                       |
| `shiv3-sc-network-resilience` | 2         | `resilience-temporary-unavailable-recovery`                                                                                                    |
| `shiv3-sc-network-resilience` | 3         | `resilience-ev-disconnect-recovery`                                                                                                            |
| `shiv3-sc-fault-negative`     | 1         | `cert16-tc024-lock-failure`                                                                                                                    |
| `shiv3-sc-fault-negative`     | 2         | `cert16-tc026-remote-start-rejected`                                                                                                           |
| `shiv3-sc-fault-negative`     | 3         | `cert16-tc028-remote-stop-rejected`                                                                                                            |
| `shiv3-sc-fault-negative`     | 4         | `cert16-tc031-unlock-unknown-connector`                                                                                                        |
| `shiv3-sc-fault-negative`     | 5         | `cert16-tc055-trigger-message-rejected`                                                                                                        |
| `shiv3-sc-fault-negative`     | 6         | `resilience-connector-fault-recovery`                                                                                                          |
| `shiv3-sc-auth-outcomes`      | 1         | `cert16-tc023-1-authorize-invalid`                                                                                                             |
| `shiv3-sc-auth-outcomes`      | 2         | `cert16-tc023-2-authorize-expired`                                                                                                             |
| `shiv3-sc-auth-outcomes`      | 3         | `cert16-tc023-3-authorize-blocked`                                                                                                             |
| `shiv3-sc-auth-outcomes`      | 4         | `resilience-authorization-rejected`                                                                                                            |
| `shiv3-sc-reservation`        | 1         | `cert16-reservation-basic`, `cert16-tc051-cancel-reservation`                                                                                  |
| `shiv3-sc-reservation`        | 2         | `cert16-tc048-1-reserve-now-faulted`, `cert16-tc048-2-reserve-now-occupied`                                                                    |
| `shiv3-sc-reservation`        | 3         | `cert16-tc048-3-reserve-now-unavailable`, `cert16-tc048-4-reserve-now-rejected`                                                                |
| `shiv3-sc-reservation`        | 4         | `cert16-tc052-cancel-reservation-rejected`                                                                                                     |
| `shiv3-sc-local-list`         | 1         | `cert16-tc042-1-get-local-list-version-not-supported`, `cert16-tc043-1-send-local-list-not-supported`, `cert16-tc043-3-send-local-list-failed` |
| `shiv3-sc-local-list`         | 2         | `cert16-tc042-2-get-local-list-version-empty`, `cert16-tc043-4-send-local-list-full`, `cert16-tc043-5-send-local-list-differential`            |
| `shiv3-sc-smart-charging`     | 1         | `cert16-tc056-central-smart-charging-txdefault`                                                                                                |
| `shiv3-sc-smart-charging`     | 2         | `cert16-tc057-central-smart-charging-txprofile`                                                                                                |
| `shiv3-sc-smart-charging`     | 3         | `cert16-tc059-remote-start-with-profile`                                                                                                       |
| `shiv3-sc-smart-charging`     | 4         | `cert16-tc066-get-composite-schedule`, `cert16-tc067-clear-charging-profile`                                                                   |
| `shiv3-sc-firmware-diag`      | 1         | `cert16-tc044-1-firmware-update`, `cert16-tc044-2-firmware-download-failed`                                                                    |
| `shiv3-sc-firmware-diag`      | 2         | `cert16-tc044-3-firmware-install-failed`, `cert16-tc045-1-get-diagnostics`                                                                     |

All 66 OCPP 1.6J templates the simulator ships are covered: 65 loaded
disabled above, plus `essential-cp-behavior` enabled on every connector.

## Apply

```sh
SIM_USER=... SIM_PASS=... bun scripts/dev-fixtures/apply.ts --url http://127.0.0.1:9700 --dry-run   # plan only
SIM_USER=... SIM_PASS=... bun scripts/dev-fixtures/apply.ts --url http://127.0.0.1:9700             # apply
SIM_USER=... SIM_PASS=... bun scripts/dev-fixtures/apply.ts --url http://127.0.0.1:9700 --verify    # read back, exit 1 on any problem
```

Needs `bun install` first (checkout at the daemon's release). Flags:
`--only <cpId>`, `--prune` (delete CPs labelled `managed-by=dev-fixtures` that
are not in `fixtures.json`; never touches CPs without the label, never
`shiv3-cp7`, and refuses ids not starting `shiv3-sc-`), `--fixtures <file>`.
Credentials only from `SIM_USER` / `SIM_PASS` (HTTP Basic, sent as the
Socket.IO `auth` payload and `Authorization` header; never printed or stored).

What it does per CP: create if missing (`cp.create`, `autoConnect:false`,
labels), `cp.update` on drift of url / version / connectors / vendor / model
(scenarios are kept), `cp.labels.set` on label drift, load missing or
wrong-`enabled` scenarios (not while that scenario is running), connect when
not connected. A CP whose id exists without the `managed-by` label is left
alone and reported. Calls are paced (<= ~50/s, <= 8 in flight; the daemon's
limit is 100/s and 64); `rate_limited` / rate-style `invalid_params` are retried
with back-off, every other error code (`invalid_params`, `not_found`,
`connect_failed`, ...) is printed with the method. A full first apply is about
190 RPC calls, a no-op re-run about 165 (reads).
`--verify` checks: CP registered with the label, connector count, vendor/model,
CP status `Available` (boot accepted), every expected scenario present with the
expected `enabled`, and no disabled scenario running.

## Persistence across a daemon restart

The daemon runs with `--state-db /data/state.db`: charge points
(`charge_points`), scenarios incl. `enabled` (`scenarios`), configuration
overrides etc. are stored and restored; on start every stored CP is recreated
and **auto-connected** (BootNotification flies again), the baseline re-arms on
connect and the disabled scenarios stay loaded and idle. A PVC loss means
re-running `apply.ts`. In-flight scenario runs and waits do not survive a
restart. The fixture CPs are not in the bootstrap flags (`shiv3-cp7` is), so
`apply.ts` is a one-time step, repeated only when `fixtures.json` changes.

## Not covered, and why

- `dataflow-authorize-branch-201`, `dataflow-remote-start-reauthorize-201`:
  OCPP 2.0.1 only (idTokenInfo / RequestStartTransaction); the dev CSMS speaks 1.6J only.
- Everything else of OCPP 2.0.1 / 2.1 (variable monitoring, 2.x transaction
  events, ISO 15118), SOAP versions 1.2 / 1.5 / 1.6S, security profiles 2/3
  (TLS certs): the CSMS is 1.6J over `wss` without client material.
- Network simulation, power loss, cellular modem, vehicle profiles, charger
  behaviors / capability profiles: run-time RPC features with no template of
  their own; use them on demand on the CP named in the table (see the concept
  docs). Not preconfigured, so the CPs stay well-mannered.
- `chargerType` / `maxPowerKw` only describe the DB port; the simulated charger
  does not cap power to it (the EV side of the baseline allows up to 150 kW).
