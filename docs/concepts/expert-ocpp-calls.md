---
title: Expert OCPP calls
type: concept
summary: Send any station-initiated OCPP-J CALL with an edited payload through the normal transport — per-version action lists, the schema check and its per-call bypass, `applyResponse`, errors, and the SOAP boundary; one API behind the console, the control plane and the `ocppCall` node.
sources:
  - src/cp/domain/types/OcppCall.ts
  - src/cp/domain/errors/OcppCallErrors.ts
  - src/cp/infrastructure/transport/codec/ocppCallCatalog.ts
  - src/cp/infrastructure/transport/codec/defaultPayload.ts
  - src/cp/infrastructure/transport/ExpertCalls.ts
  - src/console/pages/cp/ExpertCallPanel.tsx
  - "issue #389"
related:
  - control-plane.md
  - scenario-format.md
  - ocpp-versions-and-transports.md
  - ../entities/web-console.md
  - ../entities/mcp-endpoint.md
updated: 2026-10-04
---

# Expert OCPP calls

An expert OCPP call sends one station-initiated CALL that the operator chose —
any action the station may send on its OCPP-J version, with the payload as
edited — and returns the CSMS's answer. It exists for interoperability and
diagnostic testing: a one-off message no longer has to be modelled as a
high-level simulator action (#389).

Three surfaces use the same API, `ChargePoint.sendOcppCall`:

- the **Expert** section of a charge point (**More → Expert**) in the
  [web console](../entities/web-console.md);
- the `send_ocpp_call` [control-plane](control-plane.md#cp-command-methods)
  method, also a curated [MCP tool](../entities/mcp-endpoint.md) and a
  [JSON-Lines](../entities/cli.md#2-json-lines-mode) command;
- the `ocppCall` [scenario node](scenario-format.md#ocppcall-notes).

## What is sent

The CALL goes through the normal transport: the same correlation, the
`Sent:` / `Received:` log lines and therefore the
[trace export](trace-format.md#producing-records), and on OCPP 1.6 the
one-CALL-in-flight queue (§4.1.1) and the boot gate (§4.2). The frame is
`[2, <messageId>, <action>, <payload>]`, and the answer carries it back
verbatim as `sentFrame`.

Only **station-initiated** actions of the station's own version are accepted:

- **1.6J** — Authorize, BootNotification, DataTransfer,
  DiagnosticsStatusNotification, FirmwareStatusNotification, Heartbeat,
  MeterValues, StartTransaction, StatusNotification, StopTransaction; from the
  Security Whitepaper: LogStatusNotification, SecurityEventNotification,
  SignCertificate, SignedFirmwareStatusNotification.
- **2.0.1** — Authorize, BootNotification, ClearedChargingLimit, DataTransfer,
  FirmwareStatusNotification, Get15118EVCertificate, GetCertificateStatus,
  Heartbeat, LogStatusNotification, MeterValues, NotifyChargingLimit,
  NotifyCustomerInformation, NotifyDisplayMessages, NotifyEVChargingNeeds,
  NotifyEVChargingSchedule, NotifyEvent, NotifyMonitoringReport, NotifyReport,
  PublishFirmwareStatusNotification, ReportChargingProfiles,
  ReservationStatusUpdate, SecurityEventNotification, SignCertificate,
  StatusNotification, TransactionEvent.
- **2.1** — every 2.0.1 action, plus BatterySwap, ClosePeriodicEventStream,
  GetCertificateChainStatus, NotifyDERAlarm, NotifyDERStartStop,
  NotifyPriorityCharging, NotifySettlement, OpenPeriodicEventStream,
  PullDynamicScheduleUpdate, ReportDERControl, VatNumberValidation.

A test pins these lists to the vendored request schemas and to the inbound
(CSMS → station) handlers: every request schema of a version is either one the
station answers or one it sends, DataTransfer both. 2.1's
NotifyPeriodicEventStream is an OCPP-J SEND, not a CALL, and is not offered.
Any other action — a CSMS-initiated one such as `Reset`, or an unknown name —
is refused.

**SOAP** stations (OCPP 1.2, 1.5, 1.6S) are refused: their envelopes are built
per operation, so there is no path for an arbitrary action
([OCPP versions & transports](ocpp-versions-and-transports.md)).

## Schema check and the per-call bypass

The payload is checked against the version's request schema — the same check
normal traffic runs (for normal traffic it only logs a warning). A
schema-invalid payload is **refused before anything is written**, unless the
call sets `skipValidation`. With it, that one payload is sent as given and the
usual warning is logged; the check is not switched off for anything else, and
the next call — expert or normal — is checked again. The console shows the
check's result while you type and keeps **Send** disabled until the skip box is
ticked; text that is not a JSON object is never sent.

Malformed OCPP-J frames (wrong message type id, missing fields, broken JSON)
are out of scope: the frame is always well-formed, only the payload may be
invalid.

## The answer, and `applyResponse`

A call resolves with the CSMS's answer:

```json
{ "kind": "callResult", "messageId": "…", "sentFrame": "[2,…]", "payload": { … } }
{ "kind": "callError", "messageId": "…", "sentFrame": "[2,…]", "errorCode": "…", "errorDescription": "…", "errorDetails": { … } }
```

A CALLERROR is an answer, not a failure: provoking one is often the point of
the test.

By default the answer is **only logged and returned**: the station's state does
not change. An accepted BootNotification sent this way does not re-announce the
connectors or restart the heartbeat, a StartTransaction answer does not start a
transaction, a CALLERROR to Authorize does not deny the tag. Set
`applyResponse` to run the answer through the station's normal response
handling as well. On OCPP 1.6 the transaction handlers act on a connector:
the payload's `connectorId`, or for StopTransaction the connector whose
transaction has that `transactionId` — connector 1 when no connector matches.
An answer that arrives after the caller gave up (below) is still kept away
from that handling unless `applyResponse` was set.

## Errors

| Outcome                                                                                                 | Error                             | Control-plane code |
| ------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------ |
| SOAP station                                                                                            | `OcppCallRejectedError`           | `invalid_params`   |
| Not a station-initiated action of the version                                                           | `OcppCallRejectedError`           | `invalid_params`   |
| Schema-invalid payload without `skipValidation`                                                         | `OcppCallRejectedError`           | `invalid_params`   |
| A payload that is not a JSON object, even with `skipValidation`                                         | `OcppCallRejectedError`           | `invalid_params`   |
| OCPP 1.6 boot gate closed (BootNotification not yet Accepted)                                           | `OcppCallRejectedError`           | `invalid_params`   |
| No answer within 25 s                                                                                   | `OcppCallNoAnswerError` (timeout) | `timeout`          |
| The CALL never reached the wire (not connected, socket closed, write failed) or the socket closed first | `OcppCallNoAnswerError` (dropped) | `disconnected`     |

A refused call writes nothing. The message says why — the unsupported-action
message lists the version's actions, the invalid-payload message carries the
schema errors. The 25 s wait is kept under the Socket.IO client's 30 s RPC
timeout, so a remote caller sees this error rather than the client's generic
one. On OCPP 1.6 the wait starts when the call is queued: a call still waiting
behind an unanswered CALL when its 25 s are up is withdrawn and never sent, so
a caller told "no answer" never sees it go out later. A dropped call is never re-queued, including on OCPP 1.6, where a normal
StartTransaction / StopTransaction / MeterValues would be kept for a retry.

## Independence from the other fault-injection features

Expert calls are outbound only. The inbound call policies, response overrides
and certificate quirks of [scenario nodes](scenario-format.md#inboundpolicy-and-certificate-quirks-notes)
(#248, #249) and [network simulation](network-simulation.md) are untouched by
them, and they apply to expert calls exactly as to any other traffic.
