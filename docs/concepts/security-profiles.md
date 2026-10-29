---
title: OCPP 1.6 security profiles
type: concept
summary: CLI / server-mode support for the OCPP 1.6 Security Whitepaper transport profiles 1–3 (Basic Auth with AuthorizationKey, server-cert verification, mutual TLS), the related flags, configuration keys and security messages.
sources:
  - README.md (Security Profiles section, PR #97 / issue #94)
  - src/cli/
  - src/cp/domain/security/CertificateStore.ts (certificate store, issue #456)
  - src/cp/infrastructure/transport/certificateUseMapping.ts (certificate-use mapping, issue #456)
  - src/cp/infrastructure/transport/v201/certificatesV201.ts (2.x certificate handlers, issue #456)
  - src/cp/infrastructure/transport/wsUrlWithBasic.ts (scheme rule, issue #277; TLS options, issue #289)
  - https://gist.github.com/juherr/2c5ca12a562a07f7a0da7ccbbb46b160 (profile 2 behind a TLS-terminating edge, measured on 0.7.8; issue #289)
related:
  - ../entities/cli.md
  - ../entities/csms-peers.md
  - access-control.md
  - scenario-format.md
  - state-persistence.md
updated: 2026-10-29
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

The whole case — symptom, why the edge causes it, a three-probe procedure
that proves which side is at fault, the ordering trap, and the two edge
behaviours that bite afterwards (idle timeouts versus `HeartbeatInterval`;
a publicly-issued certificate needing no `--tls-ca`) — is written up with
measurements in [OCPP 1.6 security profile 2 against a CSMS behind a
TLS-terminating edge](https://gist.github.com/juherr/2c5ca12a562a07f7a0da7ccbbb46b160)
(juherr, 2026-09-03; simulator 0.7.8 against SteVe 3.14.1 behind Traefik
and Cloudflare). The witness probe there — a profile-1 station with the same
credentials answering `101` — is what rules the password out before the
proxy is suspected.

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

## Certificate store

Each charge point keeps one certificate store
(`src/cp/domain/security/CertificateStore.ts`), shared by every OCPP version.
It holds three things:

- **Trust anchors** installed by `InstallCertificate`, each with its
  `certificateHashData` (SHA-256), computed once at install time.
- **Signed chains** received by `CertificateSigned`, leaf first. Each member
  is hashed against its issuer: the next member of the chain, else an
  installed root with that subject, else the member itself.
- **Pending CSRs**, one per signing use. They are kept in memory only.

The store never retains a private key. `SignCertificate` discards the key it
generates for the CSR (the simulator does not use it), so the key cannot leave
the station (whitepaper and 2.x A02.FR.05). A returned chain is matched to its
CSR by public key.

### Certificate uses

The store speaks a version-neutral set of uses. Each version maps onto it
explicitly (`src/cp/infrastructure/transport/certificateUseMapping.ts`), and a
value that a version does not define is refused, not coerced.

| Domain use                    | 1.6 Security Whitepaper        | 2.0.1                         | 2.1                           |
| ----------------------------- | ------------------------------ | ----------------------------- | ----------------------------- |
| `CsmsRootCertificate`         | `CentralSystemRootCertificate` | `CSMSRootCertificate`         | `CSMSRootCertificate`         |
| `ManufacturerRootCertificate` | `ManufacturerRootCertificate`  | `ManufacturerRootCertificate` | `ManufacturerRootCertificate` |
| `V2GRootCertificate`          | —                              | `V2GRootCertificate`          | `V2GRootCertificate`          |
| `MORootCertificate`           | —                              | `MORootCertificate`           | `MORootCertificate`           |
| `OEMRootCertificate`          | —                              | —                             | `OEMRootCertificate`          |
| `ChargingStationCertificate`  | implicit (single use)          | `ChargingStationCertificate`  | `ChargingStationCertificate`  |
| `V2GCertificate`              | —                              | `V2GCertificate`              | `V2GCertificate`              |
| `V2G20Certificate`            | —                              | —                             | `V2G20Certificate`            |

`V2GCertificateChain` (2.x) is a `GetInstalledCertificateIds` query over the
stored `V2GCertificate` chains: each chain is reported as its leaf, with the
sub-CAs as `childCertificateHashData` (M03.FR.05). It cannot be installed.

### OCPP 1.6 behaviour

- `InstallCertificate` answers `Accepted`, or `Rejected` for a malformed
  certificate (whitepaper M05.FR.06) or when the store already holds
  `CertificateStoreMaxLength` trust anchors (M05.FR.03). It answers `Failed`
  when the state database refuses the row (M05.FR.04): nothing is installed.
  Signed chains do not count toward that limit. Installing the same
  certificate twice keeps two entries: the whitepaper says nothing about a
  reinstall.
- `GetInstalledCertificateIds` answers `Accepted` with the hash data of every
  trust anchor of the requested type, in install order, or `NotFound`.
- `DeleteCertificate` removes the first trust anchor whose hash data matches
  (hex compared case-insensitively) and answers `Accepted`. Otherwise it
  answers `NotFound`. Signed chains are not searched, so the hash of the
  Charge Point certificate answers `NotFound` and that certificate cannot be
  deleted (whitepaper M04.FR.05).
- `CertificateSigned` stores a well-formed chain that passes the certificate
  quirks without checking it against the pending CSR, and leaves that CSR
  pending. The chain replaces the previous one, so a persisted store keeps
  one chain; no 1.6 message reads it back.
- The 1.6 dispatcher starts each CALL without waiting for the previous
  one, so the answer of an async handler (`InstallCertificate`,
  `CertificateSigned`) can follow the answer to a later CALL. The store
  still runs certificate operations one at a time: a
  `GetInstalledCertificateIds` or `DeleteCertificate` sent right after an
  `InstallCertificate`, without waiting for its answer, sees the installed
  certificate.

### OCPP 2.0.1 and 2.1 behaviour

Since #456 the 2.x handlers work on the same store
(`src/cp/infrastructure/transport/v201/certificatesV201.ts`). 2.0.1 and 2.1
share them; each registry builds them with its own use mapping. A value a
version does not define (`OEMRootCertificate`, `V2G20Certificate` on 2.0.1)
fails that version's schema validator and gets a `FormationViolation`
CALLERROR.

- `InstallCertificate` answers `Accepted` once installed (M05.FR.02), or
  `Rejected` for a certificate that does not parse (M05.FR.07) or when the
  store already holds `CertificateStoreMaxLength` trust anchors (M05.FR.06).
  The limit is the 1.6 key: `SecurityCtrlr.CertificateEntries` is not
  modelled. A certificate already installed (same hash data) is replaced
  and answered `Accepted`, even when the store is full (M05.FR.17). It
  answers `Failed` when the state database refuses the row (M05.FR.03): the
  store keeps what it held before, a replaced copy included.
- `GetInstalledCertificateIds` answers `Accepted` with one
  `certificateHashDataChain` entry per installed certificate matching
  `certificateType`, or per installed certificate when it is absent
  (M03.FR.03/04). Otherwise it answers `NotFound` (M03.FR.02).
  `V2GCertificateChain` lists each stored V2G chain as its leaf, with the
  sub-CAs as `childCertificateHashData` (M03.FR.05). The schema allows 4
  children: any further sub-CA is left out, with a WARN log. A certificate
  whose use the version has no name for is left out too. This happens when a
  2.1 station installs an `OEMRootCertificate` and a 2.0.1 station later
  reads the same state database.
- `DeleteCertificate` searches the trust anchors, then the signed chains. It
  answers `Accepted` once deleted (M04.FR.02) and `NotFound` for an unknown
  hash (M04.FR.04). For the Charging Station certificate it answers `Failed`
  (M04.FR.06). Deleting a member of a V2G chain removes the whole chain,
  which M04.FR.08 allows.
- `CertificateSigned` splits `certificateChain` into PEM certificates, leaf
  first. It answers `Accepted` only when a CSR is pending for the chain's use and the
  leaf carries that CSR's public key (A02.FR.06). The chain then replaces any
  older chain of the same use, and the CSR is no longer pending. An absent
  `certificateType` means the Charging Station certificate: per the field
  description, the certificate then serves both the CSMS and the 15118
  connection, and the simulator has no 15118 stack. In every other case the
  answer is `Rejected`, nothing is stored, and the CSR stays pending. Once
  that answer is written, the station sends a `SecurityEventNotification` of
  type `InvalidChargingStationCertificate` (A02.FR.07). Its `techInfo` gives
  the reason: a malformed chain, no pending CSR, or a key mismatch. The spec
  does not name the case of a chain without a pending CSR. Rejecting it is
  this simulator's reading: such a chain cannot be checked against a key
  the station generated. The certificate quirks
  (`requiredCertificateSignatureAlgorithms`) and `MaxCertificateChainSize`
  (A02.FR.16) are not applied on 2.x.
- `sign_certificate` ([Control plane](control-plane.md#cp-command-methods))
  sends a `SignCertificateRequest`. It carries the `csr` given (at most 5500
  characters, the schema's bound; a longer one is refused as invalid
  params), or one the
  store generates with the certificate quirks' key algorithm and line endings
  and `CpoName`. That CSR becomes the pending Charging Station certificate
  CSR. `certificateType` is omitted, and so are the optional 2.1
  `requestId` and `hashRootCertificate`. A given CSR that does not parse is
  still sent, with a WARN log, but no `CertificateSigned` can match it.
- The `SignCertificateResponse` status is only logged: `Accepted` at INFO,
  any other status at WARN. A `Rejected` answer (A02.FR.12) leaves the CSR
  pending, since A02 has no rule to discard it.

The dispatcher of 2.x inbound CALLs awaits a handler only when it returns a
promise. A synchronous handler still answers in the same tick, so a
CALLRESULT keeps its place before the CALLs its follow-up sends, such as
`GetBaseReport` → `NotifyReport`. A rejected promise is answered with an
`InternalError` CALLERROR, like a handler that throws. An answer that
settles after the connection changed is not sent: the CALL is reported as
unanswered (WARN log) and the handler's follow-up does not run.

As on 1.6, the store runs certificate operations one at a time: a query or
delete sent right after an install sees it. When no operation is pending,
`GetInstalledCertificateIds` and `DeleteCertificate` still answer in the
tick of their CALL.

Not covered yet, on 2.x:

- `GetCertificateStatus` and OCSP;
- the ISO 15118 flows (`Get15118EVCertificate`, the V2G certificate as a
  TLS identity);
- `TriggerMessage` for `SignChargingStationCertificate` or
  `SignV2GCertificate`, which still answers `NotImplemented`;
- the A02.FR.17-19 resend back-off;
- the control-plane `security_event_notification` method, which only logs a
  WARN on 2.x;
- `V2G20Certificate` chains (2.1) in `GetInstalledCertificateIds`: 2.1 has
  no query value for them, and the simulator lists only `V2GCertificate`
  chains under `V2GCertificateChain` (its reading of M03.FR.05). A stored
  `V2G20Certificate` chain is therefore not reported.

Not covered yet, on 1.6 and 2.x:

- `serialNumber` in `certificateHashData` is the hex of the certificate's
  serial bytes, so it can start with `0` (`0a`), where the field
  description asks for no leading zeroes;
- whitepaper M04.FR.06 (1.6): deleting the `CentralSystemRootCertificate`
  that the current connection uses is not refused.

### Persistence

With [state persistence](state-persistence.md) on, trust anchors and signed
chains survive a restart (`certificates` table, schema v18). Pending CSRs do
not: the key pair behind a CSR is gone after a restart, and 2.x A02.FR.17
already has the station send a new CSR when no `CertificateSigned` arrives.
`cp.delete` and `state.reset` remove the rows. A trust anchor whose row the
database refuses is not installed (`InstallCertificate` answers `Failed`).
A signed chain whose row is refused is logged and kept in memory only:
`CertificateSigned` has no status for a station-side failure. A delete the
database refuses is logged too: the certificate is removed in memory only
and comes back after a restart.
