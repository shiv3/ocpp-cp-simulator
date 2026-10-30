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
  - src/cp/domain/security/SignCertificateBackoff.ts (A02.FR.17-19 resend back-off, issue #537)
  - src/cp/infrastructure/transport/OCPPMessageHandlerV201.ts (2.x SignCertificate, GetCertificateStatus, SecurityEventNotification, issue #537)
  - src/cp/infrastructure/transport/handlers/call/CertificateManagementHandlers.ts (1.6 DeleteCertificate M04.FR.06, issue #537)
  - src/cp/domain/security/get15118EVCertificate.ts (Get15118EVCertificate relay, issue #537)
  - src/cp/infrastructure/transport/OCPPWebSocket.ts (renewed client certificate, A02.FR.08 / A02.FR.28, issue #537)
  - src/cp/infrastructure/transport/wsUrlWithBasic.ts (scheme rule, issue #277; TLS options, issue #289)
  - https://gist.github.com/juherr/2c5ca12a562a07f7a0da7ccbbb46b160 (profile 2 behind a TLS-terminating edge, measured on 0.7.8; issue #289)
related:
  - ../entities/cli.md
  - ../entities/csms-peers.md
  - access-control.md
  - scenario-format.md
  - state-persistence.md
updated: 2026-10-30
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
- `--tls-cert <path>` loads the PEM client certificate for profile 3 mutual TLS. On 2.x a Charging Station certificate the CSMS renews replaces it until the next restart or `cp.update` ([Renewed client certificate](#renewed-client-certificate)).
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
`CertificateSignedMaxChainSize` is reported only: nothing enforces it.
2.x stations also carry the
[SecurityCtrlr variables](#securityctrlr-variables).
The simulator can send `SecurityEventNotification` and `SignCertificate`,
handle inbound `CertificateSigned`, and exposes the JSON-mode / RPC commands
`security_event_notification` and `sign_certificate`, plus the 2.x-only
`get_15118_ev_certificate`
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
- **OCSP responses** (2.x M06), one per certificate asked about, in memory
  only.

`serialNumber` in hash data is the lower-case hex serial without leading
zeroes (`a`, not `0a`), as the whitepaper and the 2.x
`CertificateHashDataType` ask (#537). A CSMS may send either form: matching
compares both sides without leading zeroes, and rows a state database
holds from before #537 are read back in the new form.

The store keeps the private key of a CSR it generated in memory only, never
in the state database, a snapshot or a log line, so the key cannot leave the
station (whitepaper and 2.x A02.FR.05). A returned chain is matched to its
CSR by public key. Once the chain is accepted the key stays bound to its
leaf: on 2.x it is what the station presents as its renewed TLS client
certificate ([Renewed client certificate](#renewed-client-certificate),
#537). A replaced, deleted or reset chain drops its key, and a chain signed
for a CSR the caller supplied has none.

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
stored V2G chains, `V2GCertificate` and, on 2.1, `V2G20Certificate`: each
chain is reported as its leaf, with the sub-CAs as `childCertificateHashData`
(M03.FR.05). It cannot be installed.

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
  deleted (whitepaper M04.FR.05). A `CentralSystemRootCertificate` that
  validates the current connection answers `Failed` and stays installed
  (whitepaper M04.FR.06, #537). That is one equal (DER) to a `--tls-ca`
  certificate of a `wss://` connection that verifies the server. Over
  `ws://`, without `--tls-ca` (the runtime's trust store validates) or with
  verification off, no root is in use. 2.x has no such rule.
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
  The limit is the 1.6 key, which plays `CertificateEntries.maxLimit`;
  `SecurityCtrlr.CertificateEntries` reports the same trust-anchor count
  (#537, [SecurityCtrlr variables](#securityctrlr-variables)). A
  certificate already installed (same hash data) is replaced
  and answered `Accepted`, even when the store is full (M05.FR.17). It
  answers `Failed` when the state database refuses the row (M05.FR.03): the
  store keeps what it held before, a replaced copy included.
- `GetInstalledCertificateIds` answers `Accepted` with one
  `certificateHashDataChain` entry per installed certificate matching
  `certificateType`, or per installed certificate when it is absent
  (M03.FR.03/04). Otherwise it answers `NotFound` (M03.FR.02).
  `V2GCertificateChain` lists each stored V2G chain as its leaf, with the
  sub-CAs as `childCertificateHashData` (M03.FR.05). On 2.1 that covers the
  `V2GCertificate` and `V2G20Certificate` chains, in install order: 2.1 has
  no query value of its own for ISO 15118-20 certificates (#537). A 2.0.1
  station reading a 2.1 station's state database leaves a
  `V2G20Certificate` chain out. The schema allows 4
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
  (`requiredCertificateSignatureAlgorithms`) are not applied on 2.x. A
  `certificateChain` longer than `MaxCertificateChainSize` characters is
  `Rejected` before it is parsed, with no security event (A02.FR.16: SHALL
  on 2.0.1, MAY on 2.1, applied on both). Any `CertificateSigned` for a use
  ends the resend back-off of that use's CSR, accepted (A02.FR.17) or
  rejected: as invalid (A02.FR.20) or for its size (the CSMS did answer). An
  accepted V2G chain is followed by `GetCertificateStatus` (M06.FR.07); an
  accepted Charging Station certificate, on a security-profile-3 station, by
  a reconnection that presents it
  ([Renewed client certificate](#renewed-client-certificate)).
- `sign_certificate` ([Control plane](control-plane.md#cp-command-methods))
  sends a `SignCertificateRequest`. It carries the `csr` given (at most 5500
  characters, the schema's bound; a longer one is refused as invalid
  params), or one the
  store generates with the certificate quirks' key algorithm and line endings
  and `CpoName`. That CSR becomes the pending Charging Station certificate
  CSR. `certificateType` is omitted, and so are the optional 2.1
  `requestId` and `hashRootCertificate`. A given CSR that does not parse is
  still sent, with a WARN log, but no `CertificateSigned` can match it.
- `TriggerMessage` with `SignChargingStationCertificate` or
  `SignV2GCertificate` answers `Accepted` (#537). Once the answer is written
  (F06.FR.04) the station generates a new key pair and CSR (A02.FR.02) and
  sends a `SignCertificateRequest` whose `certificateType` names the
  triggered certificate (A02.FR.03, A02.FR.13). `SignCombinedCertificate`
  and the 2.1 `SignV2G20Certificate` still answer `NotImplemented`
  (F06.FR.08).
- The `SignCertificateResponse` status is logged: `Accepted` at INFO, any
  other status at WARN. A `Rejected` answer (A02.FR.12) leaves the CSR
  pending, since A02 has no rule to discard it. An answer to a request
  whose CSR a newer one replaced is logged at INFO and otherwise ignored:
  it neither starts nor ends the back-off.
- **Resend back-off** (A02.FR.17-19, #537). After an `Accepted`
  `SignCertificateResponse`, the station waits `CertSigningWaitMinimum`
  seconds for `CertificateSigned`. When none came and the CSR is still
  pending, it resends the same request (same CSR). Every expiry doubles
  the wait, which restarts as the resend goes out: W, 2W, 4W… (A02.FR.18).
  A wait longer than a timer can hold (about 24.8 days) is waited out in
  full. A resend answered with a CALLERROR, or not at all, does not hold the
  sequence back. After `CertSigningRepeatTimes` resends it stops until a
  `TriggerMessage` starts over (A02.FR.19). One sequence runs per
  certificate use. It ends on any `CertificateSigned` for that use
  (A02.FR.20 for a rejected one), on a non-`Accepted` answer to the
  current `SignCertificate` request and when the connection closes. `sign_certificate` gets the same
  back-off.
- **`GetCertificateStatus`** (M06, #537). The station asks the CSMS for the
  OCSP status of its V2G certificates (`V2GCertificate`, 2.1
  `V2G20Certificate`): after an accepted V2G `CertificateSigned`, for the
  certificate and its sub-CAs (M06.FR.07); after every accepted boot
  (M06.FR.06); then every week while connected (M06.FR.10). One request per
  certificate. `ocspRequestData` is the certificate's hash data plus the
  OCSP URL of its Authority Information Access extension. A certificate
  without one is not asked about (OCPP requires a `responderURL`), and one
  longer than the schema allows (512 characters on 2.0.1, 2000 on 2.1) is
  skipped with a WARN. An `Accepted` answer's `ocspResult` is cached for
  that certificate, in memory (M06.FR.02/03); `Failed` keeps the previous
  entry and logs a WARN (M06.FR.04). Deleting or replacing the chain drops
  the responses cached for its certificates. The cached response is not used
  elsewhere: the simulator has no ISO 15118 stack to hand it to.
- `security_event_notification` ([Control plane](control-plane.md#cp-command-methods))
  sends an A04 `SecurityEventNotificationRequest` with the given `type`
  (at most 50 characters), the current `timestamp` and the optional
  `techInfo` (at most 255), the bounds of the 1.6 whitepaper, 2.0.1 and
  2.1 schemas; a longer value is `invalid_params` (#537; before, a WARN
  only). Like every 2.x CALL it is dropped while offline: the A04.FR.02
  queue is not modelled. The automatic `StartupOfTheDevice` event stays
  1.6-only.

#### Get15118EVCertificate relay

In M01 (certificate installation) and M02 (certificate update) an EV sends
an ISO 15118 `CertificateInstallationReq` or `CertificateUpdateReq`, and the
station forwards it to the CSMS with `Get15118EVCertificateRequest`
(M01.FR.01, M02.FR.01). The simulator has no EV link and no EXI codec, so
`get_15118_ev_certificate`
([Control plane](control-plane.md#cp-command-methods), #537) stands in for
the EV: the caller supplies the base64 EXI request and receives the CSMS's
answers.

- The parameters are the request's fields, sent as given:
  `iso15118SchemaVersion`, `action` (`Install` / `Update`), `exiRequest`
  (base64, up to 11000 characters) and the 2.1
  `maximumContractCertificateChains` and `prioritizedEMAIDs`. The station
  checks them against its version's schema before sending: on 2.0.1 the
  2.1 fields and an `exiRequest` over 5600 characters are `invalid_params`,
  and nothing is sent. 1.6 and SOAP stations have no such message and
  answer `invalid_params` too.
- The caller picks the ISO 15118 version: M01.FR.02/03 and M02.FR.02 tie
  the 2.1 fields and the Install / Update choice to the EV's protocol,
  which only the caller knows.
- The result is `{ responses, callError?, noAnswer? }`: every CALLRESULT
  payload as the CSMS sent it, in order. A CALLERROR is an answer too: it
  comes back as `callError` and ends the relay.
- With `maximumContractCertificateChains` (a 2.1 ISO 15118-20 session) the
  station sends the same request again while an `Accepted` answer says
  `remainingContracts` > 0 (2.1 M01.FR.06). It stops early when
  `remainingContracts` does not go down (M01.FR.07 has the CSMS decrease
  it), after `maximumContractCertificateChains` requests (at least one), and
  when the 25 s the relay allows for all requests together run out: no
  request is sent once they have, and the relay ends with
  `noAnswer: "timeout"`. Without the field the request is sent once.
- A first request with no answer is an error: `timeout`, or `disconnected`
  when it never reached the wire or the socket closed. A later one ends
  the relay with the answers already had and `noAnswer`.

The EXI answer goes to the caller, not to an EV, so two station duties have
no simulator behaviour: rewriting `RemainingContractCertificateChains` in the
EXI answer (2.1 M01.FR.05) and indicating a failure to the EV when the CSMS
does not answer in time (M01 / M02 error handling).

#### Renewed client certificate

When `CertificateSigned` installs a new Charging Station certificate, the
station switches to it by reconnecting the websocket and TLS connection
with it (A02.FR.08, #537). This applies to a security-profile-3 station,
whose client certificate it replaces; other profiles have none and stay
connected.

- The station presents the stored chain, leaf first, with the private key
  of the CSR it generated. The `--tls-ca` and server-name settings do not
  change.
- The station presents a renewed certificate only while the store holds
  its key. A chain signed for a CSR the caller passed to
  `sign_certificate` has none, and neither has the store once its
  Charging Station chain is replaced by such a chain or removed: the
  station then forgets every renewed certificate, the confirmed one
  included, and presents `--tls-cert` again from its next connection.
  The A02.FR.28 fallback below is the one exception: it presents the
  previous certificate with its key although the renewal already replaced
  that certificate's chain in the store. The spec imposes it.
- 2.0.1 asks the station to switch once the certificate's `notBefore` has
  passed; the simulator waits for it on 2.1 too, so a certificate not yet
  valid is switched to at that time. A manual disconnect does not cancel
  that wait. A `cp.delete` does, and so does a `cp.update`, which replaces
  the charge point: the replacement holds no key, and presents
  `--tls-cert`, as after a restart. A second `CertificateSigned`
  while the first is still being read supersedes it.
- A station that is not connected then (reconnect back-off, a simulated
  outage, a manual disconnect) does not reconnect for it: it presents the
  renewed certificate at its next connection, on that connection's timing.
- A connected station first waits, up to 60 s, until no `TransactionEvent`
  awaits its write (network-simulation latency can hold it), its answer or
  its resend (`MessageAttemptInterval`, E13). The close would not lose
  one: the [E11 offline queue](ocpp-versions-and-transports.md#e11-offline-queue-for-transactionevent)
  takes it and replays it with `offline` set after the next accepted boot.
  Waiting avoids marking offline, and resending, events the CSMS was
  about to settle. Events already queued for their replay are not waited
  for: they replay after the reconnect's boot. Past 60 s it reconnects
  anyway, and the close queues what is still in flight. The
  reconnect is otherwise a full one, as a connection loss would be: the
  station boots again; heartbeat, clock-aligned samples and monitor
  reporting stop until the boot is `Accepted`; reservations, the
  station-level charging profiles, response overrides and a running
  firmware simulation are dropped; non-transaction CALLs awaiting an
  answer are lost; and the SignCertificate back-off of every use and the
  weekly OCSP refresh stop.
- Until a connection with the renewed certificate has opened, a failed
  attempt makes the next one present the other certificate (2.1 A02.FR.28,
  alternating as B10.FR.08 describes; the reconnect back-off is unchanged).
  The other certificate is the one in use before the renewal: a renewed
  certificate confirmed earlier, else `--tls-cert`. A02.FR.28 alternates
  once every `NetworkConfigurationPriority` entry has failed; the
  simulator alternates after each failed attempt, which is the same with
  one URL but not with a list of supervision URLs. It does so on 2.0.1
  too, whose A02 has no such rule.
  If the previous certificate connects first, the renewed one is
  discarded (A02.FR.10) and the station keeps the previous one until the
  next `CertificateSigned`. The stored chain stays: the store then holds
  the discarded certificate's chain, unused, while the connection presents
  the previous one. On 2.1 the station
  then sends a `SecurityEventNotification` of type
  `DiscardedRenewedClientCertificate` once that connection's boot is
  `Accepted` (A02.FR.29). 2.0.1 defines neither the rule nor the event
  type, and sends none.
- The key is memory-only, so a restart or a `cp.update` presents
  `--tls-cert` / `--tls-key` again although the state database still
  holds the renewed chain.
- 1.6 does not switch: its `CertificateSigned` stores the chain without
  matching it to a CSR.

In ISO 15118 the V2G (SECC) certificate is the station's TLS server
certificate towards the EV, and A00.FR.428 lets the Charging Station
certificate double as one. The simulator has no EV-facing TLS link, so
neither certificate is presented to an EV.

#### SecurityCtrlr variables

2.x-only keys (#537), read and written through `GetVariables`,
`SetVariables` and `GetBaseReport`; a 1.6 station has none of them.

| Variable                  | Access | Default | Meaning                                                                     |
| ------------------------- | ------ | ------- | --------------------------------------------------------------------------- |
| `CertificateEntries`      | R      | `0`     | Installed trust anchors, the set M05.FR.06 limits (signed chains excluded)  |
| `MaxCertificateChainSize` | R      | `10000` | Longest `CertificateSigned` `certificateChain` accepted, in characters      |
| `CertSigningWaitMinimum`  | RW     | `60`    | Seconds before the first SignCertificate resend (min 1); doubled every time |
| `CertSigningRepeatTimes`  | RW     | `3`     | Resends before waiting for a `TriggerMessage`; `0` = never resend           |

`CertificateEntries` follows the certificate store: the charge point
copies the count into the configuration on every store change, so a
variable monitor on it fires too. `MaxCertificateChainSize` defaults to
the spec's `maxLimit`, also the schema's `maxLength`, so it refuses nothing
a valid frame holds. Both are ReadOnly, so a CSMS cannot change them.
Mapping `SecurityCtrlr` makes it a known component: its other variables
(`SecurityProfile`, `BasicAuthPassword`, …) now answer `UnknownVariable`
instead of `UnknownComponent`.

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

### Certificate follow-ups (#537)

What became of each item of
[#537](https://github.com/shiv3/ocpp-cp-simulator/issues/537). Requirement
ids are the 2.0.1 and 2.1 Part 2 ones unless marked.

| Item                                                                  | Outcome                                  | Requirement                                  |
| --------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| `GetCertificateStatus` and OCSP fixtures                              | Implemented                              | M06.FR.02/03/04/06/07/10                     |
| `Get15118EVCertificate`                                               | Implemented, as a control-plane relay    | M01.FR.01, M02.FR.01; 2.1 M01.FR.06          |
| Rewrite `remainingContracts` into the EXI answer                      | Declined: no EXI codec                   | 2.1 M01.FR.05                                |
| Indicate a failure to the EV                                          | Declined: no EV link                     | M01 / M02 error handling (no FR id)          |
| Renewed Charging Station certificate as the TLS client one            | Implemented: 2.x, security profile 3     | A02.FR.08; 2.1 A02.FR.28, A02.FR.10          |
| `DiscardedRenewedClientCertificate` security event                    | Implemented on 2.1                       | 2.1 A02.FR.29 (SHOULD)                       |
| V2G certificate as the TLS server one towards the EV                  | Declined: no EV link, no ISO 15118 stack | A00.FR.428, A00.FR.513                       |
| `V2G20Certificate` chains under `V2GCertificateChain`                 | Implemented on 2.1                       | M03.FR.05                                    |
| TriggerMessage `SignChargingStationCertificate`, `SignV2GCertificate` | Implemented                              | F06.FR.04, A02.FR.02/03/13                   |
| Resend SignCertificate with back-off                                  | Implemented                              | A02.FR.17-20                                 |
| 2.x `security_event_notification`                                     | Implemented                              | A04.FR.01                                    |
| Queue SecurityEventNotification while offline                         | Deferred: needs the 2.x queue of #528    | A04.FR.02                                    |
| `SecurityCtrlr.CertificateEntries`                                    | Implemented                              | variable; the limit of M05.FR.06             |
| `MaxCertificateChainSize`                                             | Implemented                              | A02.FR.16                                    |
| `serialNumber` without leading zeroes                                 | Implemented                              | `CertificateHashDataType.serialNumber` field |
| 1.6: keep the CSMS root the connection uses                           | Implemented                              | whitepaper M04.FR.06                         |

`SignV2G20Certificate` and `SignCombinedCertificate` still answer
`NotImplemented` (F06.FR.08), so a 2.1 station only gets a
`V2G20Certificate` chain for a CSR generated another way. Offline queuing
(A04.FR.02) is left to a follow-up once the 2.x offline queue of #528 is in.

### Persistence

With [state persistence](state-persistence.md) on, trust anchors and signed
chains survive a restart (`certificates` table, schema v18). Pending CSRs do
not: the key pair behind a CSR is gone after a restart, and neither does the
A02.FR.17 resend back-off; a CSMS gets a new CSR through `TriggerMessage`.
The private key of an accepted chain is gone too, so a profile-3 station
presents `--tls-cert` / `--tls-key` again after a restart
([Renewed client certificate](#renewed-client-certificate)).
Cached OCSP responses do not either: every accepted boot asks again
(M06.FR.06).
`cp.delete` and `state.reset` remove the rows. A trust anchor whose row the
database refuses is not installed (`InstallCertificate` answers `Failed`).
A signed chain whose row is refused is logged and kept in memory only:
`CertificateSigned` has no status for a station-side failure. A delete the
database refuses is logged too: the certificate is removed in memory only
and comes back after a restart.
