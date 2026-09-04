---
title: OCPP 1.6 security profiles
type: concept
summary: CLI / server-mode support for the OCPP 1.6 Security Whitepaper transport profiles 1–3 (Basic Auth with AuthorizationKey, server-cert verification, mutual TLS), the related flags, configuration keys and security messages.
sources:
  - README.md (Security Profiles section, PR #97 / issue #94)
  - src/cli/
  - src/cp/infrastructure/transport/wsUrlWithBasic.ts (scheme rule, issue #277; TLS options, issue #289)
related:
  - ../entities/cli.md
  - ../entities/csms-peers.md
  - access-control.md
  - scenario-format.md
updated: 2026-09-04
---

# OCPP 1.6 security profiles

CLI/server mode supports the OCPP 1.6 Security Whitepaper transport profiles:

| Profile | Transport                            | Authentication / certificates                                                     |
| ------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| `1`     | as configured (`ws://` or `wss://`)  | HTTP Basic Auth with CP ID as the username and `AuthorizationKey` as the password |
| `2`     | `wss://` (a `ws://` URL is upgraded) | Profile 1 plus CSMS server certificate verification (`--tls-ca` for private CAs)  |
| `3`     | `wss://` (a `ws://` URL is upgraded) | Mutual TLS with `--tls-cert` + `--tls-key`; Basic Auth is disabled                |

Profiles 2/3 and TLS certificate files are available in CLI/server mode only,
not browser local mode.

## Transport scheme rule

A security profile only ever **upgrades** the transport; it never downgrades
it (#277):

- Profiles 2 and 3 mandate TLS (Security Whitepaper A00.FR.301+). A `ws://`
  URL is connected as `wss://` and a warning is logged naming the rewrite.
- Profile 1 (A00.FR.201–207) says nothing about the transport, and
  A00.FR.206 recommends carrying Basic Auth over a channel secured by other
  means. The configured scheme is therefore authoritative: `wss://` stays
  `wss://`. This is the normal case for a CSMS behind a TLS-terminating
  reverse proxy that can only negotiate Profile 1 with the station.
- Profile 0 leaves the URL untouched.
- Profile 1 over `ws://` logs a one-line warning that the `AuthorizationKey`
  is being sent in cleartext.

The web console mirrors the same rule in the config form: selecting Profile
2/3 flips a `ws://` URL to `wss://`; selecting Profile 1 or 0 leaves the
typed scheme alone.

Before #277 (releases up to 0.7.6) Profile 1 silently rewrote `wss://` to
`ws://`, so a CSMS behind Cloudflare / Traefik / an ALB received the
credentials in cleartext on port 80 and answered with a redirect that
surfaced as `Expected 101 status code`. The rule came from #178 §1.2 and was
withdrawn by its author in #277.

> **Profile 1 over `ws://` is cleartext.** The Basic Auth header — and with
> it the `AuthorizationKey` — is visible to, and replayable by, anyone on the
> path. Use `ws://` only on a trusted local network (e.g. a SteVe on the
> same host, as in the example below); for anything reachable from an
> untrusted network use `wss://`, with Profile 1 behind a TLS-terminating
> proxy, or Profiles 2/3 for end-to-end TLS.

## Flags

- `--security-profile <0|1|2|3>` selects transport security enforcement; `0` leaves transport/auth as configured, `1` adds Basic Auth without touching the scheme, `2`/`3` force `wss://` (see [Transport scheme rule](#transport-scheme-rule)).
- `--authorization-key <hex>` sets the `AuthorizationKey` used as the Basic Auth password for profiles 1 and 2.
- `--tls-ca <path>` loads a PEM CA bundle used to verify the CSMS server certificate. **Optional, and only for a private CA** — see below.
- `--tls-cert <path>` loads the PEM client certificate for profile 3 mutual TLS.
- `--tls-key <path>` loads the PEM client private key for profile 3 mutual TLS; the file must be mode `0600`.
- `--cpo-name <name>` sets the CPO name used when generating certificate signing requests.
- `--insecure-tls-key-perms` allows a `--tls-key` file readable by group/other for local testing.

These are distinct from the daemon-side `--web-console-basic-auth-*` gate
([Access control](access-control.md)), which protects the control plane, not
the CP → CSMS link.

### `--tls-ca` is optional, and it replaces rather than adds

The flag sits under the profile 2/3 examples and reads as required. It is
not, and the first profile-2 example below passes no TLS flag at all.

- **Without `--tls-ca`**, no CA option is passed to the client and the CSMS
  certificate is verified against **the runtime's own bundled root set** —
  the Mozilla-curated public CAs that Bun and Node ship (121 of them on the
  pinned Bun), _not_ the operating system's trust store. That is what a
  publicly-issued certificate needs, so a profile-2 station against a CSMS
  behind a public certificate (Let's Encrypt, a cloud load balancer) connects
  with no TLS flag at all. A private root installed only in the OS keychain
  is **not** picked up: pass it with `--tls-ca`.
- **With `--tls-ca`**, the bundle **replaces** the default roots rather than
  adding to them, so a station configured with a private CA stops trusting
  public ones. Pass it only for a CSMS whose certificate a public root does
  not chain to, and put every root the station needs in that one file.

Verified on the daemon runtime: a `--tls-ca` holding an unrelated certificate
fails a public `wss://` handshake, so the replacement is real and not a
Node-only detail.

Certificate verification is on whenever TLS is in play; nothing here turns it
off. `rejectUnauthorized: false` exists only as an explicit per-connection
override and logs a warning when used.

### The CSMS gets a vote

Profiles 2/3 settle what the **station** does. They cannot settle what the
CSMS accepts, and a correctly configured profile-2 station can still be
refused.

The common case is a CSMS behind a TLS-terminating proxy: the edge decrypts,
so the CSMS itself sees a cleartext connection. A CSMS that enforces the
security profile then considers the connection insecure and rejects the
station — typically `401` on the WebSocket upgrade, which surfaces as
`code=1002, Expected 101 status code` and looks like a station-side fault.
Making it accept means configuring the CSMS to read the original protocol
from a forwarded header; the setting is CSMS-specific (SteVe, for one, has a
protocol-header-from-proxy setting that is empty by default). Check the CSMS
documentation.

Turning that setting on moves a security decision onto a header, so it is
only safe under two conditions, and both belong to the deployment rather than
to the station:

- **The proxy strips whatever the client sent.** `Forwarded` and
  `X-Forwarded-Proto` arrive from the network; unless the TLS-terminating
  proxy overwrites them, a station can claim `proto=https` over a cleartext
  connection and be granted a profile it never earned.
- **The CSMS trusts them only from that proxy.** A CSMS reachable other than
  through the edge must not honour the header on those paths.

The same reasoning covers the daemon's own
`--trust-forwarded-headers` ([Access control](access-control.md)).

**Configure the CSMS first, then switch the station over.** In the other
order the station is locked out in between.

## Examples (against SteVe)

```bash
# Profile 1: ws + Basic Auth against a SteVe on the same host
ocpp-cp-sim --ws-url ws://localhost:8080/steve/websocket/CentralSystemService/ \
            --cp-id CP001 --security-profile 1 \
            --authorization-key 0123456789abcdef

# Profile 1 behind a TLS-terminating proxy: wss is kept as configured
ocpp-cp-sim --ws-url wss://steve.example.com/steve/websocket/CentralSystemService/ \
            --cp-id CP001 --security-profile 1 \
            --authorization-key 0123456789abcdef

# Profile 2 against a public certificate: no TLS flag needed, the system
# trust store verifies the CSMS
ocpp-cp-sim --ws-url wss://steve.example.com/steve/websocket/CentralSystemService/ \
            --cp-id CP001 --security-profile 2 \
            --authorization-key 0123456789abcdef

# Profile 2 against a private CA: --tls-ca REPLACES the public roots
ocpp-cp-sim --ws-url wss://steve.internal.example/steve/websocket/CentralSystemService/ \
            --cp-id CP001 --security-profile 2 \
            --authorization-key 0123456789abcdef \
            --tls-ca ./certs/csms-ca.pem

# Profile 3: wss mutual TLS
chmod 600 ./certs/cp001.key
ocpp-cp-sim --ws-url wss://steve.example.com/steve/websocket/CentralSystemService/ \
            --cp-id CP001 --security-profile 3 \
            --tls-ca ./certs/csms-ca.pem \
            --tls-cert ./certs/cp001.crt \
            --tls-key ./certs/cp001.key \
            --cpo-name "Example CPO"
```

## Security extension messages and keys

Security extension configuration keys include `SecurityProfile`,
`AuthorizationKey`, `AdditionalRootCertificateCheck`,
`CertificateSignedMaxChainSize`, `CertificateStoreMaxLength`, and `CpoName`.
The simulator can send `SecurityEventNotification` and `SignCertificate`,
handle inbound `CertificateSigned`, and exposes the JSON-mode / RPC commands
`security_event_notification` and `sign_certificate`
([Control plane](control-plane.md#cp-command-methods)).

Certificate-handling quirks (RSA vs EC CSR keys, PEM line endings, accepted
signature algorithms, hidden `CpoName`) can be armed from a scenario with the
`certQuirks` node and its `octt` preset — see
[Scenario format → certificate quirks](scenario-format.md#inboundpolicy-and-certificate-quirks-notes).
