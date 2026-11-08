---
title: Default behaviors
type: entity
summary: What the station does by default for each inbound CSMS action, per OCPP version — the nine built-in behaviors, the follow-up each one runs, what ends it, the params five of them take (firmware and logs add the opt-in lifecycles of #600 and #601), and the actions that have no default and can only be replaced.
sources:
  - packages/core/src/cp/application/engine/behaviors/
  - packages/core/src/cp/application/behavior/paramsSchema.ts
  - packages/core/src/cp/application/engine/behaviors/defaultActions.ts
  - packages/core/src/cp/infrastructure/transport/handlers/buildV16CallHandlerRegistry.ts
  - packages/core/src/cp/infrastructure/transport/v201/inboundRegistryV201.ts
  - "issues #566, #654, #600, #601"
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

| Id                       | Param                   | Type and values                                                                                 | Default        | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `default.firmware`       | `stepMs`                | integer 0 to 3 600 000                                                                          | `2000`         | Time between two `FirmwareStatusNotification`s of the train.                                                                                                                                                                                                                                                                                                                                                                                     |
|                          | `failAt`                | `none`, `DownloadFailed`, `InstallationFailed`, `InvalidSignature`, `InstallVerificationFailed` | `none`         | End every update with that failure (in place of `Downloaded` / `Installed`). Anything but `none` wins over the one-shot `SimulatedFirmwareUpdateFailure` configuration key, which is still read and cleared; with `none` the key works as before. `InvalidSignature` and `InstallVerificationFailed` exist on 2.x only (ignored with a warning on 1.6); `InvalidSignature` fails the signature check even when the request carries no signature. |
|                          | `startAt`               | `retrieveDate`, `now`                                                                           | `retrieveDate` | Wait for the request's `retrieveDate`, or start as soon as the answer settled. `now` is deliberately not conformant: it retrieves before `retrieveDate` (OCPP 1.6 §5.16, §6.55 / errata 3.63); use it to test CSMS handling.                                                                                                                                                                                                                     |
|                          | `train`                 | boolean                                                                                         | `false`        | OCPP 2.x only (#600): walk the [2.x train](#ocpp-2x-firmware-train) instead of only acknowledging. 1.6 always walks its train.                                                                                                                                                                                                                                                                                                                   |
|                          | `waitForTransactions`   | boolean                                                                                         | `false`        | Hold the installation until no connector has a transaction (1.6 §5.19; 2.x L01.FR.06). Polled once a second.                                                                                                                                                                                                                                                                                                                                     |
|                          | `connectorsUnavailable` | boolean                                                                                         | `false`        | Park idle connectors `Unavailable` from the wait for transactions (or from the install, when not waiting) until the update ends, and park one that becomes idle meanwhile (1.6 §5.19; 2.x L01.FR.07). Neither the availability nor the status is persisted by the hold, and the update gives both back, also when it fails or is replaced.                                                                                                       |
|                          | `reboot`                | `none`, `afterInstalled`, `beforeInstalled`                                                     | `none`         | `beforeInstalled`: after `Installing` send BootNotification and report `Installed` once the CSMS accepted it (1.6 §5.19 "automatic reboot"; 2.x L01.FR.32 a, with `InstallRebooting` first). `afterInstalled`: report `Installed`, then send BootNotification (L01.FR.32 b). Waits up to ten minutes for the acceptance; without it `Installed` is not reported. The reported `firmwareVersion` does not change.                                 |
|                          | `jitterMs`              | integer 0 to 3 600 000                                                                          | `0`            | Add a draw from 0 to `jitterMs` to every step, from the station's seeded stream `firmware`: the same seed gives the same timing. `0` draws nothing.                                                                                                                                                                                                                                                                                              |
| `default.signedFirmware` | `stepMs`                | integer 0 to 3 600 000                                                                          | `2000`         | Time between two `SignedFirmwareStatusNotification`s.                                                                                                                                                                                                                                                                                                                                                                                            |
| `default.logs`           | `uploadMs`              | integer 0 to 3 600 000                                                                          | `2000`         | Time between `Uploading` and `Uploaded`.                                                                                                                                                                                                                                                                                                                                                                                                         |
|                          | `auto`                  | boolean                                                                                         | `true`         | OCPP 2.x only (#601): send `Uploading` and `Uploaded` after an accepted `GetLog` and answer `AcceptedCanceled` to a `GetLog` that replaces an upload. `false` is the station of before #601: acknowledge only, the control plane drives the notifications. 1.6 always uploads.                                                                                                                                                                   |
| `default.reset`          | `delayMs`               | integer 0 to 3 600 000                                                                          | `0`            | Wait this long after the answer settled before the reset takes effect (transactions stopped, then the boot or reconnect). `0` adds no wait at all. A 2.x `OnIdle` reset that is `Scheduled` is not delayed: it already waits for the last transaction.                                                                                                                                                                                           |
| `default.unlock`         | `outcome`               | `configured`, `Unlocked`, `UnlockFailed`, `NotSupported`                                        | `configured`   | The status to answer once the CALL got that far (unknown connector and ongoing transaction answers come first). `configured` answers the connector's own `unlockResponse`, which the `unlockOutcome` scenario node sets. 2.x has no `NotSupported` and answers `UnlockFailed`.                                                                                                                                                                   |

`default.diagnostics`, `default.availability`, `default.reservation` and `default.transaction` declare no params:
what they do is the station's semantics (connector state, reservations, the transaction itself), not a knob. To
change them write a [behavior](../analyses/scenario-or-behavior.md), or switch one off for a run with `useBehavior`
`mode: "disable"`.

The `unlockOutcome` node stays and is sugar for the common case: it sets the connector's `unlockResponse`
(persistently, for that connector) and `outcome: "configured"` reads it. A non-`configured` `outcome` is for the
station or the run and wins over it.

## OCPP 2.x firmware train

With `train: true` (#600) `UpdateFirmware` runs the train below on OCPP 2.0.1 and 2.1, every report carrying the
request's `requestId` (L01.FR.10, FR.20). The clause ids are those of the 2.0.1 edition 4 specification (2.1 edition 2
repeats them). With nothing selected the 2.x station only acknowledges, as it always did.

| Step                        | Status                                                                                        | When                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wait for `retrieveDateTime` | `DownloadScheduled`                                                                           | only if `retrieveDateTime` is in the future and `startAt` is `retrieveDate` (L01.FR.13)                                                                                                   |
| Download                    | `Downloading`, then after a step `DownloadFailed` when `failAt` says so                       | `retries` more attempts, `retryInterval` seconds apart, each announced by `Downloading`, before `DownloadFailed` (L01.FR.30). Absent `retries` is no retry, absent `retryInterval` is `0` |
| Downloaded                  | `Downloaded`                                                                                  | after a step (L01.FR.01)                                                                                                                                                                  |
| Signature                   | `SignatureVerified`, or `InvalidSignature` plus the `InvalidFirmwareSignature` security event | when `firmware.signature` is set, or `failAt` is `InvalidSignature` (L01.FR.03, FR.04). No signature is really checked                                                                    |
| Wait for the install        | `InstallScheduled`                                                                            | `installDateTime` in the future (L01.FR.16), or a transaction still running with `waitForTransactions` (L01.FR.34, L01.FR.06)                                                             |
| Install                     | `Installing`, then `InstallationFailed` or `InstallVerificationFailed` when `failAt` says so  | L01.FR.29                                                                                                                                                                                 |
| Reboot (`reboot`)           | `InstallRebooting`, a BootNotification, then `Installed`                                      | `beforeInstalled` (L01.FR.15, FR.32 a)                                                                                                                                                    |
| Done                        | `Installed` plus the `FirmwareUpdated` security event; `afterInstalled` then boots            | L01.FR.28, FR.31, FR.32 b                                                                                                                                                                 |

A request that arrives while a train is in progress is answered `AcceptedCanceled` and the earlier train ends at its
next wait without sending anything more (L01.FR.24 allows `DownloadFailed` / `InstallationFailed` for it, and does
not require them). A train that was replaced leaves the connectors it parked to the train that replaced it. Not
simulated: `InvalidCertificate` for a bad signing certificate (L01.FR.21, FR.22), `DownloadPaused` and a bootloader
that cannot report `Installing` (FR.23).

## Per action and version

"Answer" is the CALLRESULT; "follow-up" is the work the behavior starts once that answer settled on the wire
(it is skipped when the answer was not delivered). "Ends with" says what cuts the follow-up short; every
follow-up also ends when the behavior is unloaded or the station is disposed.

| Action                                               | OCPP 1.6                                                                                                                                                                                                                                                                                               | OCPP 2.x                                                                                                                                                                                                                                                                                                                                                 | Ends with                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `UpdateFirmware`                                     | Answer `{}`. Follow-up: `FirmwareStatusNotification` `Downloading`, `Downloaded`, `Installing`, `Installed`, two seconds apart, from `retrieveDate`. The one-shot key `SimulatedFirmwareUpdateFailure` diverts to `DownloadFailed` / `InstallationFailed`. A second CALL while a train runs is ignored | Answer `Accepted`; the `requestId` is remembered for the reports the control plane drives. **No follow-up** unless `train` is set (ack-only, kept as before); with `train`, the [2.x train](#ocpp-2x-firmware-train), and a request that replaces a train in progress is answered `AcceptedCanceled`                                                     | A connection close (the train's timers are cleared)                                           |
| `SignedUpdateFirmware`                               | Answer `Accepted`; follow-up: the signed status train (ending with `SignatureVerified`, no signature is really checked), each notification carrying `requestId`                                                                                                                                        | Not an action of 2.x (`UpdateFirmware` is the 2.x message)                                                                                                                                                                                                                                                                                               | A connection close                                                                            |
| `GetDiagnostics`                                     | Answer carries the file name. Follow-up: `DiagnosticsStatusNotification` `Uploading`, then `Uploaded` or `UploadFailed` around a real multipart POST to the URL the CSMS gave                                                                                                                          | Not an action of 2.x                                                                                                                                                                                                                                                                                                                                     | Nothing on a close: the upload goes on and its statuses go out once connected                 |
| `GetLog`                                             | Answer `Accepted` with the file name. Follow-up: `LogStatusNotification` `Uploading`, two seconds, `Uploaded`                                                                                                                                                                                          | Answer `Accepted` with a file name, or `AcceptedCanceled` when it replaces an upload in progress. Follow-up (`auto`, the default): `LogStatusNotification` `Uploading`, `uploadMs`, `Uploaded`, all with the `requestId`; the replaced upload reports `AcceptedCanceled` for its own `requestId` and never `Uploaded` (N01.FR.07 to FR.09, FR.12, FR.20) | Nothing on a close                                                                            |
| `Reset`                                              | Answer `Accepted`. Follow-up: stop every transaction, then a Soft reset boots again, a Hard reset reconnects                                                                                                                                                                                           | `Rejected` for an unknown EVSE; `Scheduled` for `OnIdle` while a targeted EVSE has a running transaction (the reset is queued and the station boots when the last one ends); else `Accepted`. Follow-up: stop transactions of the targeted EVSEs (not for `ImmediateAndResume`), drop queued OnIdle resets, boot again                                   | The pending `OnIdle` list is not persisted: a restart forgets a `Scheduled` reset             |
| `ChangeAvailability`                                 | Applies the change while it builds the answer. `Scheduled` when a transaction is in flight (kept in `scheduledAvailability` until it stops), `Rejected` for an unknown connector, else `Accepted`; connector `0` is the whole station                                                                  | Same answers; the change is applied once the answer settled (G03)                                                                                                                                                                                                                                                                                        | —                                                                                             |
| `ReserveNow` / `CancelReservation`                   | `Rejected` for an unknown, `Faulted`, `Occupied` or `Unavailable` connector; an accepted reservation moves the connector to `Reserved` (and back to `Available` on cancel) **while the answer is built**                                                                                               | Same rules; the connector moves once the answer settled                                                                                                                                                                                                                                                                                                  | —                                                                                             |
| `UnlockConnector`                                    | Unknown connector `NotSupported`; a transaction in flight is stopped first (reason `UnlockCommand`); then the connector's configured `unlockResponse` (`Unlocked` by default)                                                                                                                          | Unknown connector `UnknownConnector`; an ongoing authorized transaction `OngoingAuthorizedTransaction` (neither unlocked nor stopped); else the configured `unlockResponse`                                                                                                                                                                              | —                                                                                             |
| `RemoteStartTransaction` / `RequestStartTransaction` | `Rejected` for an unknown or inoperative connector; else `Accepted`, with `AuthorizeRemoteTxRequests` honored (an `Authorize` first), and the transaction started while the answer is built. A connector a `remoteStartTrigger` is parked on hands the request to the scenario instead                 | Same rules; the start runs once the answer settled, with `triggerReason: "RemoteStart"`                                                                                                                                                                                                                                                                  | Parking: see [call precedence](../concepts/call-precedence.md#scenario-parking-is-not-a-rule) |
| `RemoteStopTransaction` / `RequestStopTransaction`   | `Rejected` when no running transaction has that id (a transaction on the `0` placeholder after a CALLERROR does not count); else `Accepted`, connector to `SuspendedEVSE`, stop with reason `Remote` (parked connectors hand it to the scenario)                                                       | `Rejected` for an unknown transaction UUID; else `Accepted` and, once settled, the stop with `triggerReason: "RemoteStop"` (or the scenario hand-over)                                                                                                                                                                                                   | Parking                                                                                       |

A local start follows its own rule ([#181](https://github.com/shiv3/ocpp-cp-simulator/issues/181),
[#452](https://github.com/shiv3/ocpp-cp-simulator/issues/452),
[#762](https://github.com/shiv3/ocpp-cp-simulator/issues/762)): with the custom key
`AuthorizeBeforeLocalStart` on (the default) the transaction starts only after
the Authorize answer, and any status other than `Accepted` refuses it. A remote start
does not take this path; it follows `AuthorizeRemoteTxRequests` above. When the
Authorize gets no answer within 10 seconds while the socket is still up, the station
warns and proceeds as if `Accepted` (unless a not-valid local-list or cache entry
for the tag decides first). **This is deliberate and unchanged**: the transaction
then starts and the CSMS decides in `StartTransaction.conf` / `TransactionEvent`
response. A CSMS that wants a hard gate must answer Authorize. A disconnect while
waiting, or a socket that is gone at the timeout, applies the offline rules
instead. Source: `ChargePoint.authorizeAndWait`,
`application/engine/behaviors/transaction.ts`.

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

| Group                        | OCPP 1.6                                                                                     | OCPP 2.x                                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration / device model | `GetConfiguration`, `ChangeConfiguration`                                                    | `GetVariables`, `SetVariables`, `GetBaseReport`, `GetReport`, `GetMonitoringReport`, `SetVariableMonitoring`, `ClearVariableMonitoring`, `SetMonitoringBase`, `SetMonitoringLevel`, `SetNetworkProfile` |
| Triggers                     | `TriggerMessage`, `ExtendedTriggerMessage`                                                   | `TriggerMessage`                                                                                                                                                                                        |
| Cache and local list         | `ClearCache`, `GetLocalListVersion`, `SendLocalList`                                         | `ClearCache`, `GetLocalListVersion`, `SendLocalList`, `CustomerInformation`                                                                                                                             |
| Smart charging               | `SetChargingProfile`, `ClearChargingProfile`, `GetCompositeSchedule`                         | `SetChargingProfile`, `ClearChargingProfile`, `GetChargingProfiles`, `GetCompositeSchedule`                                                                                                             |
| Certificates                 | `CertificateSigned`, `InstallCertificate`, `GetInstalledCertificateIds`, `DeleteCertificate` | `CertificateSigned`, `InstallCertificate`, `GetInstalledCertificateIds`, `DeleteCertificate`                                                                                                            |
| Transactions                 | —                                                                                            | `GetTransactionStatus`                                                                                                                                                                                  |
| Display and cost             | —                                                                                            | `SetDisplayMessage`, `GetDisplayMessages`, `ClearDisplayMessage`, `CostUpdated`                                                                                                                         |
| Firmware publishing          | —                                                                                            | `PublishFirmware`, `UnpublishFirmware`                                                                                                                                                                  |
| Vendor                       | `DataTransfer`                                                                               | `DataTransfer`                                                                                                                                                                                          |

An action in neither table is not implemented by the station and gets a CALLERROR `NotImplemented`; a rule
can still own it (`replace`).

On a SOAP (1.5 / 1.6S) station the defaults answer too, but they do not go through the gate: a `replace` rule
cannot be armed there. See [OCPP versions and transports](../concepts/ocpp-versions-and-transports.md#soap-and-behaviors).
