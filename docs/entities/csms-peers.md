---
title: CSMS peers (SteVe, gocpp, others)
type: entity
summary: The central systems the simulator is regularly pointed at — SteVe for SOAP / security-profile / certification verification, gocpp for the multi-version e2e suite — and the URL / registration conventions for each.
sources:
  - scripts/steve-verify/README.md
  - e2e/README.md
  - README.md (SOAP and security-profile examples)
related:
  - ../concepts/ocpp-versions-and-transports.md
  - ../concepts/security-profiles.md
  - ../sources/steve-verify-readme.md
  - ../sources/e2e-readme.md
  - scenario-templates.md
updated: 2026-09-03
---

# CSMS peers

The simulator is the **charge point** side. Any OCPP CSMS works as the other
end; these are the ones the repository itself tests against.

## SteVe

[SteVe](https://github.com/steve-community/steve) — open-source OCPP 1.6
Central System (Java).

- **OCPP-J**: `ws://<host>:8080/steve/websocket/CentralSystemService/` — the
  URL used in the [security profile](../concepts/security-profiles.md) examples
  (Basic Auth with `AuthorizationKey`, `wss://` with `--tls-ca`, mutual TLS).
- **SOAP**: `http://<host>:8180/steve/services/CentralSystemService`. Register
  the charge box with protocol `ocpp1.2S`, `ocpp1.5S` or `ocpp1.6S`, status
  Accepted, and give the simulator a callback URL
  ([OCPP versions & transports](../concepts/ocpp-versions-and-transports.md#soap-versions-12-15-16s)).
- **Certification verification**: [`scripts/steve-verify`](../sources/steve-verify-readme.md)
  brings up a local SteVe in Docker, provisions charge boxes / tags / profiles,
  and drives all 44 [`cert16-*` templates](scenario-templates.md) through
  SteVe's REST API (`STEVE_DRIVER=api`, default) with a manager-UI fallback.
- **Known SteVe quirks** the simulator accommodates: missing REST endpoints
  for reservations / charge-point provisioning / charging profiles
  (steve#2074, #2068, #2069, #2070 — see the capability probe in the
  steve-verify README) and the OCTT-style certificate behaviors captured by the
  `certQuirks` node's `octt` preset (steve#2093, see
  [Scenario format](../concepts/scenario-format.md#inboundpolicy-and-certificate-quirks-notes)).

## gocpp

[gocpp](https://github.com/shiv3/gocpp) — a Go OCPP library by the same author.
The [e2e suite](../sources/e2e-readme.md) builds a gocpp-based CSMS fixture
(one binary, `--version=1.6|2.0.1|2.1`) and runs the simulator as a real charge
point over a real WebSocket against it, asserting on the CSMS frame log. It is
the independent implementation that validates the simulator's multi-version
wire output; the fixture also exposes `POST /command` so tests can issue
CSMS-initiated calls.

## Any other CSMS

- Point `--ws-url` (or `cp.create`'s `wsUrl`) at the CSMS OCPP-J endpoint;
  add `--basic-auth-user/pass`, `--header`, `--ws-subprotocol` as required by
  the peer.
- The Java [Testcontainers harness](../sources/testcontainers-java-readme.md)
  shows how a CSMS project can embed the simulator container in its own test
  suite.
- For a CSMS that behaves like a certification tool, the `cert16-octt-strictness-probe`
  template and strict mode surface compatibility warnings as failures.
