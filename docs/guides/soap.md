# SOAP Versions (OCPP 1.2, 1.5, 1.6S)

OCPP 1.2, 1.5, and 1.6 (SOAP) all use SOAP 1.2 / WS-Addressing over HTTP (not WebSocket).
The browser UI can run them in **send-only mode** (CP→CSMS calls work; CSMS-initiated commands
like RemoteStart and Reset are unavailable since the browser can't host the callback endpoint).
Full bidirectional SOAP remains **CLI / server-mode only**. Point `--ws-url` at the CSMS
_CentralSystemService_ URL and give the callback URL the CSMS should reach the charge point on:

## OCPP 1.2

```bash
bun src/cli/main.ts \
  --cp-id CP-001 --ocpp-version OCPP-1.2 \
  --ws-url http://csms-host:8180/services/CentralSystemService \
  --soap-callback-url http://this-host:9700/ocpp/soap/CP-001/ChargePointService \
  --json
```

OCPP 1.2 has a narrower message surface: no DataTransfer, GetConfiguration,
LocalAuthList, or Reservation messages; status values are limited to a 4-value set.

## OCPP 1.5

```bash
bun src/cli/main.ts \
  --cp-id CP-001 --ocpp-version OCPP-1.5 \
  --ws-url http://csms-host:8180/steve/services/CentralSystemService \
  --soap-callback-url http://this-host:9700/ocpp/soap/CP-001/ChargePointService \
  --json
```

## OCPP 1.6 (SOAP)

```bash
bun src/cli/main.ts \
  --cp-id CP-001 --ocpp-version OCPP-1.6S \
  --ws-url http://csms-host:8180/steve/services/CentralSystemService \
  --soap-callback-url http://this-host:9700/ocpp/soap/CP-001/ChargePointService \
  --json
```

OCPP 1.6S supports the full 1.6 message set including TriggerMessage and
charging profiles.

## Endpoint pattern

All SOAP versions share the same endpoint pattern:

- **CP → CSMS**: BootNotification, Heartbeat, StatusNotification, Authorize,
  Start/StopTransaction, MeterValues.
- **CSMS → CP**: the daemon hosts `POST <soap-path>/:cpId/ChargePointService`
  (default `--soap-path /ocpp/soap`) to answer CSMS-initiated calls — **Reset** on
  every SOAP version, and the full OCPP 1.6 command set (RemoteStart/Stop,
  TriggerMessage, ChangeAvailability, charging profiles, …) on 1.6S. The endpoint
  relies on the daemon's `--web-console-basic-auth-*` gate or a trusted network
  boundary — OCPP-S has no per-message authentication field.

## Callback URL resolution

The callback URL the CP advertises to the CSMS is resolved by precedence:

1. `--soap-callback-url <url>` — the full URL, used verbatim.
2. `--soap-public-base-url <url>` — a public base the CSMS can reach (e.g. a
   tunnel origin); the callback URL is derived as
   `<base><soap-path>/<cp-id>/ChargePointService`. Handy when the CSMS is hosted
   remotely and cannot reach your machine directly — point the base at your
   tunnel and skip hand-building the full URL. An explicit `--soap-callback-url`
   still wins.

## Pairing with SteVe

Pairs with [SteVe](https://github.com/steve-community/steve) (register charge points
with protocol `ocpp1.2S`, `ocpp1.5S`, or `ocpp1.6S`, status Accepted).
