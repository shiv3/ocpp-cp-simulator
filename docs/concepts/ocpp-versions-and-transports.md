---
title: OCPP versions and transports
type: concept
summary: What the simulator speaks — OCPP-J 1.6J (default), 2.0.1 and 2.1 over WebSocket, and OCPP-S 1.2 / 1.5 / 1.6S over SOAP 1.2 + WS-Addressing — and which surfaces support which.
sources:
  - src/ocpp/ (generated from vendor/ocpp-schemas)
  - vendor/ocpp-schemas/NOTICE
  - README.md (SOAP section)
  - src/cli/soapCallbackUrl.ts
  - src/cli/soapTunnel.ts
  - src/cli/server/CPRegistry.ts (SOAP public base derivation)
  - docs/examples/scenarios/all-cases.json
  - e2e/README.md
related:
  - ../sources/vendored-ocpp-schemas.md
  - ../entities/csms-peers.md
  - ../entities/cli.md
  - ../entities/daemon.md
  - security-profiles.md
  - trace-format.md
  - scenario-format.md
updated: 2026-09-12
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
> front of the daemon, or the https origin `--soap-tunnel ngrok` yields).

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
2. A **SOAP public base** the daemon holds — either `--soap-public-base-url
<url>` (a public origin the CSMS can reach) or the origin of the tunnel
   `--soap-tunnel ngrok` opens; the two are mutually exclusive, since both
   answer the same question. Every SOAP charge point without a callback URL —
   bootstrapped from the flags, restored from `--state-db`, or created later
   over `cp.create` / the web console — gets one derived at instantiation as
   `<base><soap-path>/<cp-id>/ChargePointService`, flagged
   `soapCallbackUrlDerived` in its config. Such a URL is **not persisted**: a
   free-tier tunnel URL changes between daemon runs, so a restored charge point
   re-derives from whatever base the daemon has now, and a `cp.update` that
   sends no `soapCallbackUrl` re-derives as well rather than freezing one
   run's origin into the row. An explicit `--soap-callback-url` still wins.
3. None — a SOAP charge point refuses to start: the CSMS has nowhere to call.

Clients read the base from the `server.info` RPC
([Control plane](control-plane.md#daemon-methods)). The web console uses it to make
the callback URL optional in the create / edit form (the derivation is shown as
the field's placeholder), and shows the effective URL on the charge point's
Configuration tab with a **Copy** button — that is the value to register in the
CSMS — noting when it came from the tunnel.

### Exposing the callback through a tunnel

`--soap-tunnel ngrok` (#183) is for a CSMS that cannot reach your machine — a
hosted SteVe, a staging environment, CI. The daemon brings the tunnel up before
anything else, derives the callback URL from it, logs both, and prints an
exposure warnings: the tunnel forwards the **whole listener** — the CSMS→CP
command endpoint, but also the control plane, the web console and the MCP
route — so the daemon applies the same gate as a non-loopback bind and refuses
to start unless `--web-console-basic-auth-user/pass` is configured or
`--unsafe-remote` is passed. Without Basic Auth the callback route is
unauthenticated: only the charge point identity in the route and whatever
boundary sits in front of the tunnel protect it. The per-charge-point
`--basic-auth-*` credentials protect the outgoing CP→CSMS connection only, not
this endpoint. With Basic Auth on, the CSMS must send those credentials on its
callbacks. No npm dependency is involved; two modes:

- **Spawn** (default) — the `ngrok` binary from `PATH` is run as
  `ngrok http <host>:<port> --log stdout --log-format json`, the public URL is
  read from its `started tunnel` log line, and the agent is killed on shutdown.
  If it dies on its own the daemon stops with exit code 1 — a SOAP charge point
  without a reachable callback cannot do its job. `--ngrok-auth-token` reaches
  the agent through its environment (`NGROK_AUTHTOKEN`), never on its command
  line or in a log line; omit it to use the agent's own config file
  (`ngrok config add-authtoken …`). `--ngrok-domain` requests a reserved domain;
  free-tier URLs change between runs, so re-register the callback in the CSMS
  each time (or let it read `wsa:From`).

  ```bash
  ocpp-cp-sim --ocpp-version OCPP-1.6S \
    --ws-url https://csms.example.com/steve/services/CentralSystemService \
    --cp-id CP1 --daemon --soap-tunnel ngrok \
    --web-console-basic-auth-user operator --web-console-basic-auth-pass secret
  # [server] SOAP tunnel (ngrok, spawn): https://a1b2.ngrok-free.app -> http://127.0.0.1:9700
  # [server] Warning: SOAP callback endpoint is publicly reachable through the tunnel at https://a1b2.ngrok-free.app/ocpp/soap/CP1/ChargePointService; …
  # [server] Warning: the tunnel forwards the whole listener on port 9700 — control plane, web console and MCP routes included — …
  ```

- **Attach** (`--ngrok-api-url <url>`) — an agent someone else runs, typically
  an `ngrok/ngrok` sidecar next to the [Docker image](../entities/docker-image.md),
  which ships no ngrok binary. The daemon reads `GET <url>/api/tunnels` and
  picks the https tunnel whose `addr` port matches its listener (or the only
  https tunnel there is), and never stops that agent. `--ngrok-auth-token` and
  `--ngrok-domain` are refused here: the agent is configured where it runs.

  ```yaml
  services:
    simulator:
      image: ghcr.io/shiv3/ocpp-cp-simulator
      command: >-
        --ocpp-version OCPP-1.6S --cp-id CP1
        --ws-url https://csms.example.com/steve/services/CentralSystemService
        --soap-tunnel ngrok --ngrok-api-url http://ngrok:4040
      # The image's entrypoint pins --unsafe-remote; add
      # --web-console-basic-auth-user/pass unless a boundary in front of the
      # tunnel (an ngrok traffic policy, for instance) handles access.
    ngrok:
      image: ngrok/ngrok
      command: http simulator:9700
      environment:
        NGROK_AUTHTOKEN: ${NGROK_AUTHTOKEN}
  ```

The flag needs a listener (`--daemon`, `--http-port` or `--web-console`) and a
SOAP `--ocpp-version`; the tunnel forwards to the API port, or to the console's
when that is the only one. A fleet (`--cp-count`) derives one callback per
charge point from the tunnel origin, exactly as with `--soap-public-base-url`.

Pairs with [SteVe](../entities/csms-peers.md#steve) (register charge points
with protocol `ocpp1.2S`, `ocpp1.5S`, or `ocpp1.6S`, status Accepted).

### SOAP limitations elsewhere in the simulator

- [Network simulation](network-simulation.md) applies to WebSocket CPs only.
- `--trace-output` does not capture SOAP frames yet; the
  [trace format](trace-format.md) already reserves `transport: "soap"`.
- [`analyze`](../entities/analyze.md) excludes SOAP records.
- **OCPP 1.5 MeterValues carry fewer measurands than every other version, and
  never two samples with the same one.** 1.5's `SampledValue` has no
  `Power.Offered`, `Current.Offered`, `Power.Factor`, `SoC`, `Frequency` or
  `RPM` measurand, and no `phase` attribute; each unsupported sample is
  dropped rather than relabelled onto a measurand 1.5 does have. 1.6-S carries
  all of them through unchanged. The canonical statement, with the reasoning
  and the tradeoff, is in
  [Scenario format → Charging curve](scenario-format.md#charging-curve-v12).

## Inbound CS→CP request validation

An inbound SOAP request on an **OCPP 1.6-S** charge point is validated
against the vendored OCPP 1.6 schema for its operation before any handler
runs. A request missing a mandatory element is answered with a SOAP Fault
naming that element:

```xml
<s:Fault>
  <s:Code><s:Value>s:Sender</s:Value></s:Code>
  <s:Reason>
    <s:Text>Invalid SetChargingProfile request: must have required property 'csChargingProfiles'</s:Text>
  </s:Reason>
</s:Fault>
```

Before #285 there was no such check, and the consequence was worse than an
unhelpful error: six operations answered a malformed request with a plausible
OCPP status — `Rejected`, `NotSupported`, `VersionMismatch`, one even
`Accepted` with a full schedule payload — so a CSMS sending an invalid
request got a well-formed verdict back and its own defect was masked. The
seventh crashed and returned a Fault carrying a raw JavaScript `TypeError`
that named an implementation variable.

What counts as invalid is the schema in full: a missing mandatory element, an
unexpected one, a value outside its type — including XML that only _looks_
numeric, since `<duration/>` and `<duration>1e2</duration>` would otherwise be
coerced into a perfectly good `0` and `100` — and a `date-time` or `uri` that
does not parse. Formats are checked on this path only; elsewhere a sloppy
timestamp from a CSMS is still worth simulating against rather than refusing.

`Reset` is covered too, although it never reaches the shared dispatcher —
the server answers it from an older registry first, and a check that covered
every operation except the one that reboots the station would be the wrong
one to have.

**Scope: 1.6-S only.** The schemas are the vendored 1.6 ones and OCPP 1.2 /
1.5 have none of their own, so validating a 1.2 request against a 1.6 schema
would reject requests that are correct for their version. Type coercion —
XML gives strings, the schema wants integers and booleans — stays
schema-guided on every dialect, because being lenient in that direction
cannot reject anything.
