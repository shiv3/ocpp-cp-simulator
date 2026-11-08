---
title: Default behaviors
type: entity
summary: What the station does by default for each inbound CSMS action, per OCPP version — the nine built-in behaviors, the follow-up each one runs, what ends it, the params five of them take, and the actions that have no default and can only be replaced.
sources:
  - packages/core/src/cp/application/engine/behaviors/
  - packages/core/src/cp/application/behavior/paramsSchema.ts
  - packages/core/src/cp/application/engine/behaviors/defaultActions.ts
  - packages/core/src/cp/infrastructure/transport/handlers/buildV16CallHandlerRegistry.ts
  - packages/core/src/cp/infrastructure/transport/v201/inboundRegistryV201.ts
  - "issues #566, #654"
related:
  - ../concepts/charger-engine.md
  - ../concepts/call-precedence.md
  - ../analyses/scenario-or-behavior.md
  - cli.md
  - ../concepts/scenario-format.md
updated: 2026-11-08
---

# Default behaviors

When a CSMS CALL is not claimed by a policy, an override, a scenario or a code behavior (see
[who answers a CALL](../concepts/call-precedence.md)), the station answers it itself. For the actions below
that answer is a **default behavior**: a `Behavior` object written against the same `ctx` API as a user
behavior, in
[`packages/core/src/cp/application/engine/behaviors/`](../../packages/core/src/cp/application/engine/behaviors/).
Read the file to read the behavior; this page is the map.

Ask a running daemon for the list with `behavior.list` (its `defaults` member: each id with the actions it
answers and, for the ones with knobs, the [params](#params) schema and defaults; MCP `behavior_list`). The same list is the set of actions a code behavior may `extend`.

Why it matters to you: **you override a default with `onCall` mode `replace`** (the default does not run) or
**`extend`** (your handler wraps it: `ctx.defaultBehavior(req)` returns the default response and registers
its follow-up). An action that has no default can only be replaced, and `extend` on it is refused when the file
loads. See [Scenario or behavior?](../analyses/scenario-or-behavior.md) for recipes.

## The nine behaviors

| Id                       | Actions                                                                                                            | Source                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `default.firmware`       | `UpdateFirmware`                                                                                                   | [`firmware.ts`](../../packages/core/src/cp/application/engine/behaviors/firmware.ts)             |
| `default.signedFirmware` | `SignedUpdateFirmware`                                                                                             | [`signedFirmware.ts`](../../packages/core/src/cp/application/engine/behaviors/signedFirmware.ts) |
| `default.diagnostics`    | `GetDiagnostics`                                                                                                   | [`diagnostics.ts`](../../packages/core/src/cp/application/engine/behaviors/diagnostics.ts)       |
| `default.logs`           | `GetLog`                                                                                                           | [`logs.ts`](../../packages/core/src/cp/application/engine/behaviors/logs.ts)                     |
| `default.reset`          | `Reset`                                                                                                            | [`reset.ts`](../../packages/core/src/cp/application/engine/behaviors/reset.ts)                   |
| `default.availability`   | `ChangeAvailability`                                                                                               | [`availability.ts`](../../packages/core/src/cp/application/engine/behaviors/availability.ts)     |
| `default.reservation`    | `ReserveNow`, `CancelReservation`                                                                                  | [`reservation.ts`](../../packages/core/src/cp/application/engine/behaviors/reservation.ts)       |
| `default.unlock`         | `UnlockConnector`                                                                                                  | [`unlock.ts`](../../packages/core/src/cp/application/engine/behaviors/unlock.ts)                 |
| `default.transaction`    | `RemoteStartTransaction`, `RemoteStopTransaction` (1.6); `RequestStartTransaction`, `RequestStopTransaction` (2.x) | [`transaction.ts`](../../packages/core/src/cp/application/engine/behaviors/transaction.ts)       |

A user behavior may not use an id that starts with `default.` (refused at load). The `ctx.state` of the
defaults is not persisted; the statuses they report are.

## Params

Five defaults have knobs. A knob is a **param**: JSON, validated against the schema `behavior.list` reports for
the behavior (its `defaults` member lists them too), refused when it does not fit and never converted. With
nothing set every param has the value the behavior had before params existed, and the traffic on the wire is
unchanged (the [golden wire test](../analyses/testing-strategy.md#golden-wire-test) holds that).

Set them where a behavior is selected: a scenario's [`useBehavior`](../concepts/scenario-format.md#usebehavior-params-and-disable-schema-16)
`params` (for the run), `--behavior-params <id>=<json file or inline json>` on the command line, and
`behaviorParams` on `cp.create` / `cp.update` / a blueprint or `cp.behaviors.set` (for the station, stored with it). The id is the one in the table above.

| Id                       | Param      | Type and values                                          | Default        | Effect                                                                                                                                                                                                                                                                         |
| ------------------------ | ---------- | -------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `default.firmware`       | `stepMs`   | integer 0 to 3 600 000                                   | `2000`         | Time between two `FirmwareStatusNotification`s of the 1.6 train. OCPP 2.x has no train.                                                                                                                                                                                        |
|                          | `failAt`   | `none`, `DownloadFailed`, `InstallationFailed`           | `none`         | End every update with that failure (in place of `Downloaded` / `Installed`). Anything but `none` wins over the one-shot `SimulatedFirmwareUpdateFailure` configuration key, which is still read and cleared; with `none` the key works as before.                              |
|                          | `startAt`  | `retrieveDate`, `now`                                    | `retrieveDate` | Wait for the request's `retrieveDate`, or start as soon as the answer settled.                                                                                                                                                                                                 |
| `default.signedFirmware` | `stepMs`   | integer 0 to 3 600 000                                   | `2000`         | Time between two `SignedFirmwareStatusNotification`s.                                                                                                                                                                                                                          |
| `default.logs`           | `uploadMs` | integer 0 to 3 600 000                                   | `2000`         | 1.6: time between `Uploading` and `Uploaded`. OCPP 2.x has no sequence.                                                                                                                                                                                                        |
| `default.reset`          | `delayMs`  | integer 0 to 3 600 000                                   | `0`            | Wait this long after the answer settled before the reset takes effect (transactions stopped, then the boot or reconnect). `0` adds no wait at all. A 2.x `OnIdle` reset that is `Scheduled` is not delayed: it already waits for the last transaction.                         |
| `default.unlock`         | `outcome`  | `configured`, `Unlocked`, `UnlockFailed`, `NotSupported` | `configured`   | The status to answer once the CALL got that far (unknown connector and ongoing transaction answers come first). `configured` answers the connector's own `unlockResponse`, which the `unlockOutcome` scenario node sets. 2.x has no `NotSupported` and answers `UnlockFailed`. |

`default.diagnostics`, `default.availability`, `default.reservation` and `default.transaction` declare no params:
what they do is the station's semantics (connector state, reservations, the transaction itself), not a knob. To
change them write a [behavior](../analyses/scenario-or-behavior.md), or switch one off for a run with `useBehavior`
`mode: "disable"`.

The `unlockOutcome` node stays and is sugar for the common case: it sets the connector's `unlockResponse`
(persistently, for that connector) and `outcome: "configured"` reads it. A non-`configured` `outcome` is for the
station or the run and wins over it.

## Per action and version

"Answer" is the CALLRESULT; "follow-up" is the work the behavior starts once that answer settled on the wire
(it is skipped when the answer was not delivered). "Ends with" says what cuts the follow-up short; every
follow-up also ends when the behavior is unloaded or the station is disposed.

| Action                                               | OCPP 1.6                                                                                                                                                                                                                                                                                               | OCPP 2.x                                                                                                                                                                                                                                                                                                               | Ends with                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `UpdateFirmware`                                     | Answer `{}`. Follow-up: `FirmwareStatusNotification` `Downloading`, `Downloaded`, `Installing`, `Installed`, two seconds apart, from `retrieveDate`. The one-shot key `SimulatedFirmwareUpdateFailure` diverts to `DownloadFailed` / `InstallationFailed`. A second CALL while a train runs is ignored | Answer `Accepted`; the `requestId` is remembered for the reports the control plane drives. **No follow-up** (ack-only, kept as before; a user behavior opts in to a train)                                                                                                                                             | A connection close (the train's timers are cleared)                                           |
| `SignedUpdateFirmware`                               | Answer `Accepted`; follow-up: the signed status train (ending with `SignatureVerified`, no signature is really checked), each notification carrying `requestId`                                                                                                                                        | Not an action of 2.x (`UpdateFirmware` is the 2.x message)                                                                                                                                                                                                                                                             | A connection close                                                                            |
| `GetDiagnostics`                                     | Answer carries the file name. Follow-up: `DiagnosticsStatusNotification` `Uploading`, then `Uploaded` or `UploadFailed` around a real multipart POST to the URL the CSMS gave                                                                                                                          | Not an action of 2.x                                                                                                                                                                                                                                                                                                   | Nothing on a close: the upload goes on and its statuses go out once connected                 |
| `GetLog`                                             | Answer `Accepted` with the file name. Follow-up: `LogStatusNotification` `Uploading`, two seconds, `Uploaded`                                                                                                                                                                                          | Answer `Accepted` with a file name. **No follow-up** (ack-only; a user behavior opts in)                                                                                                                                                                                                                               | Nothing on a close                                                                            |
| `Reset`                                              | Answer `Accepted`. Follow-up: stop every transaction, then a Soft reset boots again, a Hard reset reconnects                                                                                                                                                                                           | `Rejected` for an unknown EVSE; `Scheduled` for `OnIdle` while a targeted EVSE has a running transaction (the reset is queued and the station boots when the last one ends); else `Accepted`. Follow-up: stop transactions of the targeted EVSEs (not for `ImmediateAndResume`), drop queued OnIdle resets, boot again | The pending `OnIdle` list is not persisted: a restart forgets a `Scheduled` reset             |
| `ChangeAvailability`                                 | Applies the change while it builds the answer. `Scheduled` when a transaction is in flight (kept in `scheduledAvailability` until it stops), `Rejected` for an unknown connector, else `Accepted`; connector `0` is the whole station                                                                  | Same answers; the change is applied once the answer settled (G03)                                                                                                                                                                                                                                                      | —                                                                                             |
| `ReserveNow` / `CancelReservation`                   | `Rejected` for an unknown, `Faulted`, `Occupied` or `Unavailable` connector; an accepted reservation moves the connector to `Reserved` (and back to `Available` on cancel) **while the answer is built**                                                                                               | Same rules; the connector moves once the answer settled                                                                                                                                                                                                                                                                | —                                                                                             |
| `UnlockConnector`                                    | Unknown connector `NotSupported`; a transaction in flight is stopped first (reason `UnlockCommand`); then the connector's configured `unlockResponse` (`Unlocked` by default)                                                                                                                          | Unknown connector `UnknownConnector`; an ongoing authorized transaction `OngoingAuthorizedTransaction` (neither unlocked nor stopped); else the configured `unlockResponse`                                                                                                                                            | —                                                                                             |
| `RemoteStartTransaction` / `RequestStartTransaction` | `Rejected` for an unknown or inoperative connector; else `Accepted`, with `AuthorizeRemoteTxRequests` honored (an `Authorize` first), and the transaction started while the answer is built. A connector a `remoteStartTrigger` is parked on hands the request to the scenario instead                 | Same rules; the start runs once the answer settled, with `triggerReason: "RemoteStart"`                                                                                                                                                                                                                                | Parking: see [call precedence](../concepts/call-precedence.md#scenario-parking-is-not-a-rule) |
| `RemoteStopTransaction` / `RequestStopTransaction`   | `Rejected` when no running transaction has that id (a transaction on the `0` placeholder after a CALLERROR does not count); else `Accepted`, connector to `SuspendedEVSE`, stop with reason `Remote` (parked connectors hand it to the scenario)                                                       | `Rejected` for an unknown transaction UUID; else `Accepted` and, once settled, the stop with `triggerReason: "RemoteStop"` (or the scenario hand-over)                                                                                                                                                                 | Parking                                                                                       |

Version differences that are on purpose and part of the contract: 1.6 `UpdateFirmware` runs a status train
and 2.x does not, and 1.6 reservation / availability change the connector while the answer is built where
2.x does it once the answer settled. Both are the behavior of the simulator before the engine existed, and
the [golden wire test](../analyses/testing-strategy.md#golden-wire-test) holds them.

## Actions with no default

These actions are answered directly by the OCPP handlers of
[1.6](../../packages/core/src/cp/infrastructure/transport/handlers/buildV16CallHandlerRegistry.ts) or
[2.x](../../packages/core/src/cp/infrastructure/transport/v201/inboundRegistryV201.ts). A code behavior or a
scenario can **replace** them (mode `replace`, `callResponse`), but there is no default to extend: `mode:
"extend"` for one of them is refused when the behavior loads, naming the action. To change one in a small
way you rebuild the answer by hand (for `Accepted` / `Rejected`, `ctx.accepted(action)` and
`ctx.rejected(action)` give the valid answer of the station's version).

| Group                        | OCPP 1.6                                                                                     | OCPP 2.x                                                                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Configuration / device model | `GetConfiguration`, `ChangeConfiguration`                                                    | `GetVariables`, `SetVariables`, `GetBaseReport`, `GetReport`, `GetMonitoringReport`, `SetVariableMonitoring`, `ClearVariableMonitoring`, `SetMonitoringBase`, `SetMonitoringLevel`, `SetNetworkProfile`, `CustomerInformation` |
| Triggers                     | `TriggerMessage`, `ExtendedTriggerMessage`                                                   | `TriggerMessage`                                                                                                                                                                                                               |
| Cache and local list         | `ClearCache`, `GetLocalListVersion`, `SendLocalList`                                         | `ClearCache`, `GetLocalListVersion`, `SendLocalList`                                                                                                                                                                           |
| Smart charging               | `SetChargingProfile`, `ClearChargingProfile`, `GetCompositeSchedule`                         | `SetChargingProfile`, `ClearChargingProfile`, `GetChargingProfiles`, `GetCompositeSchedule`                                                                                                                                    |
| Certificates                 | `CertificateSigned`, `InstallCertificate`, `GetInstalledCertificateIds`, `DeleteCertificate` | `CertificateSigned`, `InstallCertificate`, `GetInstalledCertificateIds`, `DeleteCertificate`                                                                                                                                   |
| Transactions                 | —                                                                                            | `GetTransactionStatus`                                                                                                                                                                                                         |
| Display and cost             | —                                                                                            | `SetDisplayMessage`, `GetDisplayMessages`, `ClearDisplayMessage`, `CostUpdated`                                                                                                                                                |
| Firmware publishing          | —                                                                                            | `PublishFirmware`, `UnpublishFirmware`                                                                                                                                                                                         |
| Vendor                       | `DataTransfer`                                                                               | `DataTransfer`                                                                                                                                                                                                                 |

An action in neither table is not implemented by the station and gets a CALLERROR `NotImplemented`; a rule
can still own it (`replace`).

On a SOAP (1.5 / 1.6S) station the defaults answer too, but they do not go through the gate: a `replace` rule
cannot be armed there. See [OCPP versions and transports](../concepts/ocpp-versions-and-transports.md#soap-and-behaviors).
