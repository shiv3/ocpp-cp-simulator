---
title: Diagnostics and log upload
type: concept
summary: How the station answers GetDiagnostics (1.6) and GetLog (1.6 Security Whitepaper, 2.x) — the default simulated GetLog train, the opt-in real upload (`RealLogUpload`, HTTP PUT, destination checks, retries, statuses, cancellation) and the decisions behind it.
sources:
  - packages/core/src/cp/application/engine/behaviors/logs.ts
  - packages/core/src/cp/application/engine/behaviors/diagnostics.ts
  - packages/core/src/cp/application/engine/behaviors/uploadRetry.ts
  - packages/core/src/cp/application/engine/behaviors/logArtifact.ts
  - packages/core/src/cp/domain/charge-point/uploadUrl.ts
  - packages/core/src/cp/infrastructure/fileUpload.ts
  - packages/core/src/test/behavior/getLogUpload.bun.test.ts
  - "issue #926"
  - "issue #743"
  - "issue #601"
related:
  - ../entities/default-behaviors.md
  - ocpp-versions-and-transports.md
  - charger-engine.md
updated: 2026-11-15
---

# Diagnostics and log upload

Three CSMS requests ask the station for a file: `GetDiagnostics` (OCPP 1.6
base protocol), `GetLog` of the 1.6 Security Whitepaper and `GetLog` of OCPP
2.0.1 / 2.1. The default behaviors are
[`default.diagnostics` and `default.logs`](../entities/default-behaviors.md).

| Request                          | Default                                                                                                                                           | Real transfer                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1.6 `GetDiagnostics`             | Always real: a multipart `POST` of `diagnostics.txt` (the logger lines, `startTime`..`stopTime`) to `location`; `retries`, `retryInterval` (#743) | always                                                                      |
| 1.6 Security Whitepaper `GetLog` | Simulated: `Uploading`, then `Uploaded` after `uploadMs`; nothing is sent                                                                         | `RealLogUpload` true (#926)                                                 |
| 2.0.1 / 2.1 `GetLog`             | Simulated (#601): the same train with `requestId`; `auto` off leaves the notifications to the control plane                                       | `RealLogUpload` true (#926); with `auto` off the station still only answers |

## Real `GetLog` upload (#926)

Off by default: the simulated train, and its wire output, are unchanged, so
certification scenarios and golden-wire fixtures keep working. Two simulator
configuration keys control the real mode. Both are **read-only for the CSMS**
(`ChangeConfiguration` and `SetVariables` are `Rejected`, like
`AuthorizeRemoteTxRequestsReadOnly`): a CSMS must not be able to switch on the
transfer of simulator data. The operator writes them with `set_config_key`, a
scenario `configSet` node or a persisted override.

| Key                          | Default | Meaning                                                                                     |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `RealLogUpload`              | `false` | `GetLog` uploads a real file                                                                |
| `LogUploadAllowPrivateHosts` | `false` | Accept a loopback / private / link-local destination (a CSMS on the operator's own network) |

With `RealLogUpload` true, for both versions:

1. **Validation first.** `logType` other than `DiagnosticsLog` (the simulator
   keeps no security log, and a diagnostics file is not relabeled) and a
   destination the check below refuses are answered `Rejected` (2.x adds
   `statusInfo.reasonCode` `UnsupportedParam` or `InvalidURL`). A rejected request
   starts nothing and does not cancel a running upload.
2. **Answer, then act.** `Accepted` (or `AcceptedCanceled` when an upload is
   running) with the file name `<cpId>-DiagnosticsLog-<requestId>.jsonl`; the
   notifications follow the CALLRESULT.
3. **Snapshot at request time.** The file is built when the request arrives,
   not when the upload (or a retry) runs: one JSON object per line
   (`timestamp`, `level`, `type`, `message`; secrets in the message redacted),
   limited to `log.oldestTimestamp`..`log.latestTimestamp`, and bounded to
   1 MiB. When it would be larger the oldest entries are dropped and the first
   line is `{"truncated": N}`.
4. **Upload.** `HTTP PUT` of the file as the raw body to `log.remoteLocation`,
   `Content-Disposition: attachment; filename="…"`, `Content-Type:
application/x-ndjson`. A 2xx is success. Redirects are not followed (a 3xx
   is a failed attempt). Each attempt times out after 60 s. `retries` (at most
   10 per request) are the attempts after the first, `retryInterval` the
   seconds between them (30 when absent). One upload runs at a time.
5. **Statuses.** `LogStatusNotification` `Uploading` once, then `Uploaded`
   **only after a 2xx**, or `UploadFailure` once every attempt failed (HTTP
   error, refused connection, timeout). All carry the `requestId`.
6. **Cancellation.** A second accepted `GetLog` while one runs cancels it: the
   answer is `AcceptedCanceled`, the replaced upload never reports `Uploaded`
   (a 2xx that arrives after the replacement is ignored; the in-flight HTTP
   attempt itself is not aborted) and on 2.x reports `AcceptedCanceled` for its own
   `requestId` (N01.FR.12, FR.20); on 1.6 only the new request reports
   (Security Whitepaper N01.FR.11). A status sent from outside for the same
   `requestId` (control plane, scenario `notify` node) takes the train over and
   the station sends nothing more for it.

### Destination checks

Only `http` and `https`; no `user:password@` in the URL; unless
`LogUploadAllowPrivateHosts` is true, no `localhost`, `*.localhost`,
`*.local`, `*.internal`, and no loopback, private (RFC 1918), carrier-NAT,
link-local (cloud metadata `169.254.169.254`), unique-local, multicast or
IPv4-mapped IPv6 address (integer and hex IPv4 spellings are normalized by the
URL parser first). The check reads the URL text only: a public name that
resolves to a private address (DNS rebinding) is **not** caught, because the
core also runs in the browser and cannot resolve names; run the daemon where
its network cannot reach internal services if that matters. `GetDiagnostics`
keeps its existing behavior (any URL `fetch` accepts) so the #743 wire does not
change.

### Decisions (#926)

- **HTTP `PUT` with a raw body, not the `GetDiagnostics` multipart `POST`.**
  The #743 note asks not to apply that wire format to `GetLog`; a log is stored
  at the location the CSMS names. Rejected alternative: reuse `UploadFile`.
  The attempt loop (`uploadRetry.ts`) is shared; the transport is injected
  (`ChargePointDeps.logUploader`, default `PutFile`).
- **A separate `RealLogUpload` switch, not a `GetLog` behavior param.** It is
  an ordinary configuration key, so it is discoverable with `GetConfiguration`
  and writable by the operator on a running station. Rejected: a behavior
  param (not visible to the CSMS).
- **Switch read-only for the CSMS.** Rejected: writable, so a CSMS could turn
  the feature on by itself (the #925 bundle must stay opt-in).
- **`SecurityLog` is `Rejected`** rather than served the diagnostics file
  (#925 §3).
- **`UploadFailure`** is the failure status of both versions' `GetLog`
  (`UploadFailed` is the 1.6 `GetDiagnostics` spelling).
