---
title: Local authorization
type: concept
summary: How a charge point decides a local transaction start — Local Authorization List first, then the Authorization Cache, then Authorize.req online or the offline rules (`LocalPreAuthorize`, `LocalAuthorizeOffline`, `AllowOfflineTxForUnknownId`) — what the persisted cache stores, how CSMS answers fill it, how ClearCache empties it, the OCPP 2.x device-model mapping, and the control-plane seam that reads, seeds and clears it.
sources:
  - src/cp/domain/auth/LocalAuthorizationResolver.ts
  - src/cp/domain/auth/AuthorizationCache.ts
  - src/cp/domain/auth/StationAuthorization.ts
  - src/cp/domain/auth/LocalAuthList.ts
  - src/cp/domain/charge-point/ChargePoint.ts (authorizeAndWait, startTransaction)
  - src/cp/infrastructure/transport/handlers/callresult/TransactionResultHandlers.ts
  - src/cp/infrastructure/transport/handlers/call/OtherCallHandlers.ts (ClearCacheHandler)
  - src/cp/infrastructure/transport/v201/deviceModelMap.ts
  - src/cp/infrastructure/transport/v201/authorizationCacheV201.ts
  - src/cp/infrastructure/transport/v201/coreControlV201.ts (handleClearCacheV201)
  - src/cp/domain/auth/AuthorizationCacheSeed.ts
  - src/protocol/methods.ts (get/seed/clear_auth_cache)
  - "issue #181"
  - "issue #452"
related:
  - state-persistence.md
  - charging-sessions.md
  - ../sources/cert16-templates-readme.md
  - ../entities/cli.md
  - control-plane.md
  - ../entities/mcp-endpoint.md
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

- **Filled from CSMS answers.** With `AuthorizationCacheEnabled=true`,
  each 1.6 Authorize.conf, StartTransaction.conf and StopTransaction.conf
  carrying an `idTagInfo` inserts or updates the entry of the request's
  idTag (§3.5.1, §4.1); on 2.x, see [OCPP 2.x](#ocpp-2x). A local decision never writes it, so an identifier
  accepted offline as unknown is not cached (C15.FR.01) — the
  StartTransaction.conf that follows the reconnect does cache it. The only
  other writer is the test seam
  [`seed_auth_cache`](#control-plane-seam), which writes whatever the
  switch says.
- **No CSMS answer for a listed identifier.** A CSMS answer for an
  identifier present in the Local Authorization List is not added to the
  cache (§3.5.3). The seed does not check the list.
- **Capacity.** At 1,000 entries, a new identifier evicts the oldest entry
  that is not valid, else the oldest valid one (1.6 §3.5.1, C10.FR.07).
- **Persistence.** With `--state-db` (and in the browser), the cache lives in
  the [`authorization_cache`](state-persistence.md#tables) table and
  survives a restart (1.6 §3.5.1 with errata v4.0 §3.4, C10.FR.02).
  `state.reset` and `cp.delete` remove it like every per-charge-point table.
- **ClearCache (1.6).** A 1.6 ClearCache.req (WebSocket or SOAP) empties the cache
  and answers `Accepted`, also while the cache is disabled; `Rejected` only
  if the stored copy could not be cleared (§5.4). Errata v4.0 §3.23
  (`Rejected` when no cache is implemented) does not apply: the simulator
  implements one, which the presence of `AuthorizationCacheEnabled` reports
  (§9.1.2). 2.x answers differently: see [OCPP 2.x](#ocpp-2x).

The Local Authorization List keeps each entry's `expiryDate` and
`parentIdTag` when SendLocalList carries them, because the offline rules
need the expiry. The list itself still lives in memory only.

## OCPP 2.x

OCPP 2.0.1 and 2.1 charge points run the same decision on the same store.
Get/SetVariables and GetBaseReport reach the keys through the device model
(2.0.1 Part 2, referenced components §2.3–§2.4):

| Component.Variable                       | Store key                    |
| ---------------------------------------- | ---------------------------- |
| `AuthCacheCtrlr.Enabled`                 | `AuthorizationCacheEnabled`  |
| `AuthCacheCtrlr.LifeTime`                | `AuthCacheLifeTime`          |
| `AuthCtrlr.LocalPreAuthorize`            | `LocalPreAuthorize`          |
| `AuthCtrlr.LocalAuthorizeOffline`        | `LocalAuthorizeOffline`      |
| `AuthCtrlr.OfflineTxForUnknownIdEnabled` | `AllowOfflineTxForUnknownId` |
| `LocalAuthListCtrlr.Enabled`             | `LocalAuthListEnabled`       |

- `AuthCacheLifeTime` exists on 2.x charge points only, so a 1.6
  GetConfiguration lists the same keys as before. It counts seconds from an
  entry's last CSMS update (see Limits for how that differs from C10.FR.08); `0`, the default, means no lifetime, and
  a negative value is `Rejected`. An entry past its lifetime is treated as
  absent from the cache.
- `AuthCacheCtrlr.Policy`, `Storage` and `Available` (all "Required: no")
  are not mapped. Because `AuthCacheCtrlr` is now a known component, they
  answer `UnknownVariable` instead of `UnknownComponent`.
- **Filling the cache.** The `idTokenInfo` of an AuthorizeResponse and of a
  TransactionEventResponse updates the entry of the request's `idToken`
  (C10.FR.04, C10.FR.05), whatever the status, `groupIdToken` as parent id.
  `cacheExpiryDateTime` becomes the entry's own expiry and overrides
  `LifeTime` (C10.FR.13); without it, `LifeTime` applies. A missing or empty
  idToken, a `NoAuthorization` one, and the `Invalid` the station makes up
  when Authorize gets a CALLERROR are never cached.
- **ClearCache (C11).** With `AuthCacheCtrlr.Enabled=true` the cache is
  cleared and the answer is `Accepted` (C11.FR.03), or `Rejected` if
  clearing failed (C11.FR.05). With `Enabled=false` the answer is
  `Rejected` and the content is kept (C11.FR.04; the AuthCacheEnabled note
  says switching the cache off does not alter its content). This differs on
  purpose from 1.6, which clears and answers `Accepted` either way.

**Behaviour change in #452 (2.x wire).** Under the default configuration
(cache disabled), ClearCache now answers `Rejected` instead of `Accepted`.
GetBaseReport lists the five new variables.

## Control-plane seam

Three CP command methods (see [control plane](control-plane.md)) and MCP
tools let a test or a campaign inspect and prepare the cache without the
database. None sends anything to the CSMS, and seed and clear act whatever
the cache switch says.

| Method             | MCP tool           | Result                   |
| ------------------ | ------------------ | ------------------------ |
| `get_auth_cache`   | `auth_cache_get`   | `{ enabled, entries }`   |
| `seed_auth_cache`  | `auth_cache_seed`  | `{ seeded }` (the count) |
| `clear_auth_cache` | `auth_cache_clear` | `{ cleared }`            |

`seed_auth_cache` takes `entries`, an array of
`{ idToken, status, expiresAt?, parentId? }`, never a record keyed by
identifier. `idToken` and `parentId` are 1–36 characters; `status` is one of
the 1.6 or 2.x authorization statuses; `expiresAt` must parse as a date.
At most 1,000 entries, each `idToken` once. A seeded identifier that is
also in the Local Authorization List is stored, but the list still decides
for it (C13.FR.01). One invalid entry refuses the
whole seed with `invalid_params`, and nothing is written. Entries read back
with ISO `expiresAt`, `insertedAt` and `updatedAt`.

## Limits

- No `StatusNotification` with `LocalListConflict` (§3.5.2) is sent when a
  CSMS answer contradicts the Local Authorization List.
- No Master Pass group (`AuthCtrlr.MasterPassGroupId`, C12.FR.09) and no
  `AuthCacheCtrlr.DisablePostAuthorize`.
- `AuthCacheCtrlr.LifeTime` runs from the entry's last update by the CSMS,
  whereas §2.4.3 / C10.FR.08 count it "since it is last used": a local
  accept from the cache does not restart it.
- No built-in scenario template drives a cached-authorization case (TC_007
  style); the seed method is the building block for one.
