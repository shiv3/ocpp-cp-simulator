---
title: Local authorization
type: concept
summary: How a charge point decides a local transaction start — Local Authorization List first, then the Authorization Cache, then Authorize.req online or the offline rules (`LocalPreAuthorize`, `LocalAuthorizeOffline`, `AllowOfflineTxForUnknownId`) — and what the persisted cache stores, how CSMS answers fill it and how ClearCache empties it.
sources:
  - src/cp/domain/auth/LocalAuthorizationResolver.ts
  - src/cp/domain/auth/AuthorizationCache.ts
  - src/cp/domain/auth/StationAuthorization.ts
  - src/cp/domain/auth/LocalAuthList.ts
  - src/cp/domain/charge-point/ChargePoint.ts (authorizeAndWait, startTransaction)
  - src/cp/infrastructure/transport/handlers/callresult/TransactionResultHandlers.ts
  - src/cp/infrastructure/transport/handlers/call/OtherCallHandlers.ts (ClearCacheHandler)
  - "issue #181"
  - "issue #452"
related:
  - state-persistence.md
  - charging-sessions.md
  - ../sources/cert16-templates-readme.md
  - ../entities/cli.md
updated: 2026-10-29
---

# Local authorization

A local transaction start — one the charge point initiates itself, not a
RemoteStartTransaction — is authorized before it begins (#181). Since #452
the charge point first looks the identifier up in its **Local Authorization
List** and its **Authorization Cache**, and decides alone when OCPP lets it:
online with `LocalPreAuthorize`, and always when offline. Otherwise it sends
`Authorize.req` and waits for the answer, as before. The rules follow OCPP
1.6 Part 2 §3.5 and 2.0.1 Part 2 C10–C15.

The whole gate sits behind the simulator's custom key
`AuthorizeBeforeLocalStart` (default `true`). With `false`, a local start
neither sends Authorize.req nor consults the list or the cache, offline
included — the pre-#181 wire. A RemoteStart-triggered start skips the gate
too.

## Configuration keys

| Key                          | Default | Effect                                                                                 |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `AuthorizationCacheEnabled`  | `false` | Consult and fill the Authorization Cache (1.6 §9.1.2)                                  |
| `LocalAuthListEnabled`       | `true`  | Consult the Local Authorization List                                                   |
| `LocalPreAuthorize`          | `false` | Online: start for a valid local entry without Authorize.req (§9.1.13)                  |
| `LocalAuthorizeOffline`      | `true`  | Offline: start for a valid local entry (§9.1.12)                                       |
| `AllowOfflineTxForUnknownId` | `false` | Offline: start for an identifier neither the list nor the cache knows (§3.5.4)         |
| `AuthorizeBeforeLocalStart`  | `true`  | Simulator key: run this gate at all (#181)                                             |
| `StopTransactionOnInvalidId` | `true`  | Unchanged by #452: what a non-Accepted StartTransaction.conf does to a running session |

## Decision

The charge point is **online** while its WebSocket is open. A SOAP charge
point has no connection state and always counts as online.

The deciding entry is the Local Authorization List entry when there is one,
otherwise the cache entry: the list has priority for the same identifier
(1.6 §3.5.3, C13.FR.01, C14.FR.01). An entry is **valid** when its status
is `Accepted` and its expiry date has not passed. An `Accepted` entry past
its expiry date counts as `Expired` (1.6 §3.5.1 and §3.5.4, C10.FR.10).

| Situation               | Online                                                 | Offline                                                        |
| ----------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| Valid entry             | `LocalPreAuthorize`: start at once; else Authorize.req | `LocalAuthorizeOffline`: start; else treated as unknown        |
| Entry that is not valid | Authorize.req (§3.5.1, C10.FR.03, C14.FR.03)           | Refused with the entry's status (§3.5.4 MUST)                  |
| No entry                | Authorize.req (§4.1 SHALL)                             | `AllowOfflineTxForUnknownId`: start; else refused as `Invalid` |

- A refused start emits `authorizeDenied` and returns
  `{ started: false, denialStatus }`, exactly like a refusal from
  Authorize.conf.
- An offline decision is immediate: no Authorize.req, no wait.
- Online, while waiting for Authorize.conf: a disconnect hands the decision
  to the offline column. A timeout with the socket still open resolves
  `Accepted` (warn-and-proceed, unchanged since #181); a timeout after the
  socket closed uses the offline column too.
- `LocalAuthorizeOffline=false` only stops a valid entry from authorizing.
  An entry that is not valid is still refused; it never becomes "unknown".

**Behaviour change in #452.** Before, an offline local start waited 10 s for
an Authorize.conf that could not come, then started anyway. Now, under the
default configuration, an offline start with an identifier that is in
neither the list nor the cache is **refused** at once. Set
`AllowOfflineTxForUnknownId=true` to accept it as before. The auto-traffic
runner, which calls the same authorization, is refused offline the same
way. Online with the cache disabled, the wire is unchanged: Authorize.req,
Authorize.conf, then StartTransaction.req.

## Authorization Cache

One entry per identifier: the status as received (valid and NOT-valid alike,
1.6 §3.5.1, C10.FR.01), the optional expiry date and parent id
(`idTagInfo.expiryDate` / `parentIdTag`), the insertion time and the last
update time.

- **Filled from CSMS answers only.** With `AuthorizationCacheEnabled=true`,
  each 1.6 Authorize.conf, StartTransaction.conf and StopTransaction.conf
  carrying an `idTagInfo` inserts or updates the entry of the request's
  idTag (§3.5.1, §4.1). A local decision never writes it, so an identifier
  accepted offline as unknown is not cached (C15.FR.01) — the
  StartTransaction.conf that follows the reconnect does cache it.
- **Never for a listed identifier.** An identifier present in the Local
  Authorization List is not added to the cache (§3.5.3).
- **Capacity.** At 1,000 entries, a new identifier evicts the oldest entry
  that is not valid, else the oldest valid one (1.6 §3.5.1, C10.FR.07).
- **Persistence.** With `--state-db` (and in the browser), the cache lives in
  the [`authorization_cache`](state-persistence.md#tables) table and
  survives a restart (1.6 §3.5.1 with errata v4.0 §3.4, C10.FR.02).
  `state.reset` and `cp.delete` remove it like every per-charge-point table.
- **ClearCache.** A 1.6 ClearCache.req (WebSocket or SOAP) empties the cache
  and answers `Accepted`, also while the cache is disabled; `Rejected` only
  if the stored copy could not be cleared (§5.4). Errata v4.0 §3.23
  (`Rejected` when no cache is implemented) does not apply: the simulator
  implements one, which the presence of `AuthorizationCacheEnabled` reports
  (§9.1.2).

The Local Authorization List keeps each entry's `expiryDate` and
`parentIdTag` when SendLocalList carries them, because the offline rules
need the expiry. The list itself still lives in memory only.

## Limits

- No `StatusNotification` with `LocalListConflict` (§3.5.2) is sent when a
  CSMS answer contradicts the Local Authorization List.
- OCPP 2.0.1 / 2.1 charge points run the same decision on the same keys, but
  their AuthorizeResponse / TransactionEventResponse do not fill the cache
  yet, and their ClearCache still answers `Accepted` without clearing.
