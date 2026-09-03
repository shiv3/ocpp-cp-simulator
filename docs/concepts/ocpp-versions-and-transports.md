---
title: OCPP versions and transports
type: concept
summary: What the simulator speaks — OCPP-J 1.6J (default), 2.0.1 and 2.1 over WebSocket, and OCPP-S 1.2 / 1.5 / 1.6S over SOAP 1.2 + WS-Addressing — and which surfaces support which.
sources:
  - src/ocpp/ (generated from vendor/ocpp-schemas)
  - vendor/ocpp-schemas/NOTICE
  - README.md (SOAP section)
  - docs/examples/scenarios/all-cases.json
  - e2e/README.md
related:
  - ../sources/vendored-ocpp-schemas.md
  - ../entities/csms-peers.md
  - ../entities/cli.md
  - ../entities/daemon.md
  - security-profiles.md
  - trace-format.md
updated: 2026-09-03
---

# OCPP versions and transports

| Version    | Transport                        | Flag value   | Browser (Local mode) | CLI / daemon     | Notes                                                                |
| ---------- | -------------------------------- | ------------ | -------------------- | ---------------- | -------------------------------------------------------------------- |
| OCPP 1.6J  | OCPP-J (JSON over WebSocket)     | `OCPP-1.6J`  | ✅                   | ✅ (default)     | Primary target; DebugKit `analyze`, k6 export, cert16 templates      |
| OCPP 2.0.1 | OCPP-J                           | `OCPP-2.0.1` | ✅                   | ✅               | Validated against gocpp in the [e2e suite](../sources/e2e-readme.md) |
| OCPP 2.1   | OCPP-J                           | `OCPP-2.1`   | ✅                   | ✅               | Wire output identical to 2.0.1 for the scenario node set             |
| OCPP 1.2   | OCPP-S (SOAP 1.2, WS-Addressing) | `OCPP-1.2`   | send-only            | ✅ bidirectional | Narrower message surface (see below)                                 |
| OCPP 1.5   | OCPP-S                           | `OCPP-1.5`   | send-only            | ✅ bidirectional |                                                                      |
| OCPP 1.6S  | OCPP-S                           | `OCPP-1.6S`  | send-only            | ✅ bidirectional | Full 1.6 message set incl. TriggerMessage and charging profiles      |

Message types and validators for the JSON versions are generated from the
[vendored OCA schemas](../sources/vendored-ocpp-schemas.md).

## Version-agnostic scenarios

The scenario engine is version-agnostic: the same
[scenario file](scenario-format.md) runs under `--ocpp-version OCPP-1.6J`,
`OCPP-2.0.1` or `OCPP-2.1` and each node emits the wire message appropriate
to that version (e.g. `remoteStartTrigger` waits for `RemoteStartTransaction`
on 1.6 and `RequestStartTransaction` on 2.x). `docs/examples/scenarios/all-cases.json`
is the node-type catalogue exercised across all three versions by
`e2e/comprehensive.gocpp.e2e.ts` ([Example scenarios](../sources/example-scenarios.md)).

## SOAP versions (1.2, 1.5, 1.6S)

OCPP 1.2, 1.5, and 1.6 (SOAP) all use SOAP 1.2 / WS-Addressing over HTTP
(not WebSocket). The browser UI can run them in **send-only mode** (CP→CSMS
calls work; CSMS-initiated commands like RemoteStart and Reset are unavailable
since the browser can't host the callback endpoint). Full bidirectional SOAP
remains **CLI / server-mode only**. Point `--ws-url` at the CSMS
_CentralSystemService_ URL and give the callback URL the CSMS should reach the
charge point on.

> The `http://` examples below are for a **local / trusted-network** CSMS
> such as a SteVe checkout on the same machine. OCPP-S carries no per-message
> authentication and the callback endpoint is gated only by the daemon's
> Basic Auth or the network boundary, so for a remote CSMS or a tunnel use
> `https://` on both sides (`--ws-url https://…`, an HTTPS
> `--soap-public-base-url` / `--soap-callback-url` terminated by a proxy in
> front of the daemon).

**OCPP 1.2:**

```bash
bun src/cli/main.ts \
  --cp-id CP-001 --ocpp-version OCPP-1.2 \
  --ws-url http://csms-host:8180/services/CentralSystemService \
  --soap-callback-url http://this-host:9700/ocpp/soap/CP-001/ChargePointService \
  --json
```

OCPP 1.2 has a narrower message surface: no DataTransfer, GetConfiguration,
LocalAuthList, or Reservation messages; status values are limited to a 4-value set.

**OCPP 1.5:**

```bash
bun src/cli/main.ts \
  --cp-id CP-001 --ocpp-version OCPP-1.5 \
  --ws-url http://csms-host:8180/steve/services/CentralSystemService \
  --soap-callback-url http://this-host:9700/ocpp/soap/CP-001/ChargePointService \
  --json
```

**OCPP 1.6 (SOAP):**

```bash
bun src/cli/main.ts \
  --cp-id CP-001 --ocpp-version OCPP-1.6S \
  --ws-url http://csms-host:8180/steve/services/CentralSystemService \
  --soap-callback-url http://this-host:9700/ocpp/soap/CP-001/ChargePointService \
  --json
```

OCPP 1.6S supports the full 1.6 message set including TriggerMessage and
charging profiles.

All SOAP versions share the same endpoint pattern:

- **CP → CSMS**: BootNotification, Heartbeat, StatusNotification, Authorize,
  Start/StopTransaction, MeterValues.
- **CSMS → CP**: the daemon hosts `POST <soap-path>/:cpId/ChargePointService`
  (default `--soap-path /ocpp/soap`) to answer CSMS-initiated calls — **Reset** on
  every SOAP version, and the full OCPP 1.6 command set (RemoteStart/Stop,
  TriggerMessage, ChangeAvailability, charging profiles, …) on 1.6S. The endpoint
  relies on the daemon's `--web-console-basic-auth-*` gate or a trusted network
  boundary — OCPP-S has no per-message authentication field
  ([Access control](access-control.md#basic-auth-gate)).

The callback URL the CP advertises to the CSMS is resolved by precedence:

1. `--soap-callback-url <url>` — the full URL, used verbatim.
2. `--soap-public-base-url <url>` — a public base the CSMS can reach (e.g. a
   tunnel origin); the callback URL is derived as
   `<base><soap-path>/<cp-id>/ChargePointService`. Handy when the CSMS is hosted
   remotely and cannot reach your machine directly — point the base at your
   tunnel and skip hand-building the full URL. An explicit `--soap-callback-url`
   still wins.

Pairs with [SteVe](../entities/csms-peers.md#steve) (register charge points
with protocol `ocpp1.2S`, `ocpp1.5S`, or `ocpp1.6S`, status Accepted).

### SOAP limitations elsewhere in the simulator

- [Network simulation](network-simulation.md) applies to WebSocket CPs only.
- `--trace-output` does not capture SOAP frames yet; the
  [trace format](trace-format.md) already reserves `transport: "soap"`.
- [`analyze`](../entities/analyze.md) excludes SOAP records.
