---
title: "Source: scripts/bench/README.md (fleet scale benchmark)"
type: source
summary: fleet-bench.ts grows a fleet against a real CSMS via cp.create_many, drives heartbeats/transactions, and diffs the daemon's /metrics scrapes to report N vs. p50/p95 OCPP call latency — the measurement tool for issue #302's scale ceiling.
sources:
  - scripts/bench/README.md
  - scripts/bench/fleet-bench.ts
  - scripts/bench/lib.ts
related:
  - ../entities/daemon.md#measured-scale-ceiling
  - ../analyses/fleet-load-and-observability-roadmap.md#5a-measured-scale-ceiling
  - ../concepts/control-plane.md#cpcreate_many--the-batch-fields
updated: 2026-09-04
---

# Source: `scripts/bench/README.md`

**Purpose.** Answer "how many charge points can one daemon hold before OCPP
timing visibly degrades" — the question
[issue #302](github-issues.md) opened because nothing in the code enforced or
measured one. This is a benchmark, not a test: no pass/fail assertion, only a
printed table.

**Run.** `bun scripts/bench/fleet-bench.ts --csms-url <ws(s)://...> --daemon-url
<http(s)://...>` against a daemon already started with `--metrics`. Flags
(`--counts`, `--duration`, `--heartbeat-interval`, `--tx-interval`, ...) sweep
ascending fleet sizes; see the README's flag table for the full set and
defaults. An unknown flag is an error, not a silently ignored argument — a
mistyped `--duraton 5` fails before the first charge point exists.

**OCPP-J only, and the version is explicit.** `--csms-url` takes `ws://` or
`wss://` and **rejects `http(s)://`**. `ocppcp_ocpp_call_duration_seconds` has
no SOAP equivalent (a SOAP log line carries no message id to correlate a
response with), so a SOAP fleet would produce an empty latency table; accepting
an HTTP URL used to quietly run a 1.6J WebSocket fleet instead. `--ocpp-version`
picks the version every benchmarked charge point is created with —
`OCPP-1.6J` (default), `OCPP-2.0.1` or `OCPP-2.1`, with the three SOAP versions
rejected for the same reason. It is passed through to `cp.create_many`, which
defaults to `OCPP-1.6J` on its own: against a 2.x-only CSMS the omission made
every handshake fail and the run report an unsettled fleet and no data. On 2.x
there is no `timeouts` column at all — the 30s per-CALL watchdog exists only in
the OCPP-1.6J handler (see [Daemon → Metrics](../entities/daemon.md#metrics))
and nothing else feeds that counter, so the column reads `n/a` rather than a
`0` that would read as "none abandoned"; the script says so on stderr.

**Warmup, so a step's timeouts are its own.** `ocppcp_ocpp_call_timeouts_total`
increments 30s _after_ the CALL, when its watchdog fires, so the delta between
the two scrapes bracketing a window covers calls issued 30s earlier — during
the previous step, or this step's boot and stagger ramp, at a different `N`.
Each step therefore holds the new `N` **and its load** for `--warmup` seconds
before the `before` scrape; the default is `30 + --tx-interval` (one watchdog
interval plus the stagger ramp, which is one cycle period long on the active
axis and zero on the idle one, which starts no transactions to ramp).
With it, a row's `timeouts` covers exactly the calls issued between 30s before
the window opened and 30s before it closed, all at that step's `N`; calls issued
in the window's last 30s expire during the next step's warmup and are counted in
neither row — dropped, never misattributed. `--warmup 0` opts out for a smoke
run, with a printed note. Latency, `late>30s`, `errors` and `reconnects` do not
depend on it.

**The transaction stagger is deterministic and phased off global fleet
indices.** A charge point's phase is fixed once, from its index in the whole
fleet, never from its index within the step that created it — so two runs with
the same flags issue the same traffic pattern and a knee is reproducible from
the options recorded in `--out`, the project's "every random behaviour is seeded
and replayable" rule met by having no randomness at all here.

Per-cohort spacing was the trap: the fleet is grown in place and the load is
armed once per step with only that step's new charge points, so spacing each
cohort evenly across the period restarted the phase at 0 every step. With
`--counts 1,2,3` and step durations that are multiples of the period, all three
landed in nearly the same phase — a burst, and a latency knee belonging to the
tool rather than to the daemon. Exact even spacing cannot survive growth without
re-phasing the running fleet, which would mean clearing in-flight transaction
timers and re-issuing `start_transaction` mid-session, so the phases come from
the van der Corput sequence in base 2 instead: _every prefix_ of it is
near-uniform, which is exactly the property a fleet that grows needs. The widest
silent stretch is at most `2/n` of a period at fleet size `n`, against `1/n` for
a perfect ring. The span is the cycle period rather than the raw
`--tx-interval`, which differ at `--tx-interval 1` because a hold is floored at
1s.

The offsets are also **anchored to a run-wide epoch**, not to each cohort's own
arming. A global sequence fixes which fraction of the period a charge point
gets, not what that fraction is measured from, and creation, settling and
heartbeat arming take variable time — so scheduling from each cohort's own
finish rotated every cohort by an arbitrary amount and let well-separated
indices collide in wall-clock phase anyway. Each first cycle is rebased modulo
the period against one epoch fixed before the first charge point exists, so an
index means the same instant whichever step created it.

**Method.** Grows the fleet in place via `cp.create_many` (never
`state.reset` — that is daemon-wide destructive), waits for each step's new
CPs to settle, then diffs two `/metrics` scrapes bracketing a measurement
window to isolate that step's `ocppcp_ocpp_call_duration_seconds` histogram
from the daemon's whole-lifetime cumulative counters. p50/p95 come from
linear interpolation within the bucket the target quantile falls in (the same
approximation Prometheus's `histogram_quantile()` uses); a quantile past the
last finite bucket edge (30s) is reported as `>30s`, never fabricated.
Settling is read off the `ocppcp_charge_points` gauge rather than `cp.list`:
that method's _result_ schema is `ARRAY_1000`, so polling it past 1000 charge
points fails validation and answers `internal` — which used to abort the
documented sweep exactly where the tool is most interesting. The gauge is one
bounded number at any fleet size, so `--counts` may genuinely reach its 2000
cap.

**Preflight refuses a daemon whose `/metrics` predates the benchmark.** Probed
by the eviction counter, which is rendered unconditionally, so its absence means
"too old" rather than "nothing has happened". Without it an older daemon passes
every other check and then reports `timeouts 0` — on OCPP-1.6J the headline knee
signal, reading zero because the counter is missing rather than because no call
was abandoned.

**Preflight refuses a non-empty daemon.** `/metrics` carries no `cpId` label by
design, so charge points the bench did not create would put their traffic in
the same histogram while the reported `N` counted only the bench's own fleet.
`--allow-existing` waives the refusal and records the pre-existing count in the
report and in the `--out` file.

**Timeouts are their own counter.** The headline knee signal is the
`ocppcp_ocpp_call_timeouts_total` delta (the `timeouts` column), not the
histogram's overflow bucket: a duration is only observed when an answer
arrives, so a CALL the CSMS never answers contributes nothing to the histogram
and a saturated CSMS used to report `>30s=0, errors=0`. The overflow bucket is
still reported, as `late>30s` — calls the CSMS _did_ answer, after the charge
point's 30s watchdog had given up.

**A correlation-cache eviction is not a timeout.** Only the transport giving up
on a CALL increments `ocppcp_ocpp_call_timeouts_total`; the recorder dropping an
in-flight CALL because it already tracks 4096 of them is a capacity event, now
counted on its own as `ocppcp_ocpp_pending_calls_evicted_total` (see
[Daemon → Metrics](../entities/daemon.md#metrics)). The bench diffs that counter
per step and warns on stderr when it moves, because each eviction costs one
duration sample — the row's `p50`/`p95` then rest on fewer observations than its
`calls` column implies.

**Connectivity is read from the final scrape.** The `connected` column is the
fleet that generated the row's histogram, not the one the settle poll saw before
the warmup, and `dropped` is how many had settled and were gone by the end.
Reporting the settle-time count attributed a window's latency to a fleet larger
than the one producing it; a disconnect during the _warmup_ is the worst case,
because its reconnect attempts land before the `before` scrape and leave even
the `reconnects` column at zero. Both ends of the step are in `--out`
(`connectedAtSettle` and `connected`), and a non-zero drop is warned about on
stderr.

**The hardware block says whose hardware it is.** `os.cpus()`, `os.totalmem()`
and `Bun.version` describe the process running the script, which is the machine
under test only when `--daemon-url` is local. A local run prints
`machine (daemon host, and this runner):`; a remote one prints
`benchmark client, NOT the daemon host:` plus `daemon host: UNKNOWN` and says
to record the daemon host by hand, and `--out` carries the same distinction as
`daemonHostIsRunner`. Since [the acceptance criteria on
#302](github-issues.md) require a published ceiling to name the machine it was
measured on, a wrong attribution would be quotable and false — worse than a
missing one.

**A row is labelled with the fleet it describes.** `cp.create_many` succeeds
partially, so `N` is the number of charge points that actually exist and
`uncreated` is how many the step's `--counts` entry asked for and did not get.
Reporting the requested size attributed a row's latency to a fleet that never
existed.

**Every charge point presents its own idTag.** Sharing `DEFAULT_ID_TAG`
(`123456`) made a CSMS that enforces per-idTag concurrency answer
`ConcurrentTx` to every concurrent start after the first, so the active axis
applied a fraction of the load it reported — the fourth distinct route to "the
generated load is not the configured load", and the first arriving from outside
the harness. The tag is deterministic and fits OCPP 1.6's `CiString20`
`IdToken`; it is passed per `start_transaction` rather than as an idTag pool set
at creation, because `cp.create_many` shares every field across a batch except
the id and the SOAP callback URL, so a pool would be identical for the whole
batch.

**Teardown never treats an acknowledgement as a completion.** The invariant
behind the teardown rules, and the one every teardown bug here has violated:
_teardown may not consider an operation finished before the bound that operation
itself uses._ A `stop_transaction` ack means the daemon queued
`StopTransaction`, not that it sent it, so teardown watches
`ocppcp_ocpp_messages_total` until the frames leave before deleting — otherwise
a backlogged serializer has its queued CALL discarded with the charge point. A
`Promise.race` rejecting on abort does not cancel its loser, so teardown awaits
the `cp.create_many` still running rather than deleting provisional ids whose
charge points appear a moment later. And the wait for in-flight cycles uses the
cycle's own bound — the authorization timeout plus, on 1.6, the assigned-id
timeout — never a smaller number chosen at the teardown site.

The same invariant governs the bookkeeping as well as the waiting, but the
proof is not available. Teardown re-stops every charge point that may have an
open transaction, acked or not, and does not try to work out which ones still
need it. **Delivery to the CSMS is not verified**, and cannot be from the
bench: the fleet-wide `StopTransaction` counter carries no `cpId` label by
design, so an aggregate cannot establish a per-charge-point fact; and
`connector.transactionId` going `null` is done synchronously by
`ChargePoint.stopTransaction` before the frame is queued, so it says nothing
about the wire. Both were tried and both were wrong. The wire is observable in
principle — `OCPPWebSocket.writeUpstreamPhysical` logs `Sent: …` right after
`this._ws.send(raw)` — but reading it back needs `logs.get`, whose
`listStoredLogs` returns nothing unless the daemon runs with `--state-db`,
which the benchmark does not require. So under a backed-up outbound queue a
queued stop can still be discarded with the charge point; that is a documented
limitation rather than a check that looks like proof.
than incremented — a cycle awaits in exactly four places (the start RPC, the
confirmation wait, the hold, the stop RPC) and nowhere else, which is what
makes it complete rather than merely larger than last time. All of this is on
the preventable side of the split below, so only the ordering protects it.

**Open transactions are closed before deletion, and that is a third
invariant.** `stop()` only cancels timers, and roughly half an active fleet is
inside its hold at any moment, so cancelling those callbacks and deleting the
charge points left the CSMS holding transactions that could never be ended.
Teardown waits briefly for in-flight cycles, then issues and awaits a stop for
every transaction it believes open. Unlike the two daemon invariants — record
ids before creation and read them after creation stops; delete only what this
run created — this one concerns a third-party system with no listing to
reconcile against, so it can only be met by construction and never repaired
afterwards.

**The two start emissions are told apart by order, not by value.** OCPP 1.6's
`transactionId` is schema-valid for any integer, zero included, so testing
`transactionId === 0` for "still the placeholder" left a CSMS that assigns 0
unrecognised — the cycle waited its full timeout and retired the charge point
despite a valid confirmation. The first emission after arming is the local
start, the second the assigned id whatever it carries, and "no id arrived" is
`null`, which `0` could not express; `null` alone triggers retirement.

**Known limitation, not fixable from the bench.** Against a CSMS that assigns
`transactionId: 0` the second emission never arrives: `CLIChargePointService`
suppresses the `transactionIdChange` it would come from
(`src/cli/service.ts`, `if (transactionId === 0) return`). The cycle waits its
full bound and retires the charge point despite a valid confirmation, so the
offered load drops — visibly in the `retired` column, but for the wrong reason.
Tracked as issue #328: the fix belongs to the daemon's event contract, and the
`transactionIdChange` setter is reached only from the CALLRESULT handlers, so
removing that guard would add an emission solely in the assigned-zero case.

**The stop waits for the assigned transaction id.** On OCPP 1.6
`transaction_started` is emitted twice — locally with the placeholder id `0`,
then again when `StartTransaction.conf` supplies the real one — and each waiter
is bound to its own cycle so a straggling conf from the previous cycle is
ignored while this cycle's own id is still waited for. Taking only the first
emission satisfied the first requirement and broke the second:
`sendStopTransaction` snapshots the id immediately, so a conf slower than the
hold sent `0` and produced CALLERRORs and corrupted connector state, near the
latency knee the tool exists to find. Bounded at the authorization wait plus the
per-CALL watchdog, past which no id is ever coming; OCPP 2.x assigns no numeric
id, so nothing is waited for there.

**The stop waits for the assigned transaction id.** On OCPP 1.6
`transaction_started` is emitted twice — locally with the placeholder id `0`,
then again when `StartTransaction.conf` supplies the real one — and each waiter
is bound to its own cycle, so a straggling conf from the previous cycle is
ignored while this cycle's own id is still waited for. Taking only the first
emission satisfied that first requirement and broke the second:
`sendStopTransaction` snapshots the id immediately, so a conf slower than the
hold sent `0` and produced CALLERRORs and corrupted connector state, near the
latency knee the tool exists to find. Bounded at the authorization wait plus the
per-CALL watchdog, past which no id is ever coming; OCPP 2.x assigns no numeric
id, so nothing is waited for there.

**The hold runs from the local start, and a charge point whose id never
arrives is retired.** Starting the hold timer once the assigned id had been
confirmed added the whole `StartTransaction.conf` latency to each transaction's
on-time, so the duty cycle stopped matching the configuration; the remaining
hold is now measured from the local start, and a hold that has already elapsed
stops at once and is counted in the `late hold` column. A charge point whose id
does not arrive inside the bound stops cycling and is counted in `retired`,
because its conf may still land during a later cycle and be taken for that
cycle's id — the event carries no generation, so a stale conf cannot be told
from a fresh one, and withdrawing the charge point is what makes the confusion
impossible rather than unlikely.

**A create whose client deadline expired keeps creating.** `cp.create_many`
rejecting at its 35s deadline does not stop the daemon's sequential handler, so
the delete sweep answered `not_found` for ids registered moments later and those
survived to be refused by the next run's preflight. Ids reported `not_found` are
re-swept once after a further RPC deadline, because "not there yet" and "already
gone" are indistinguishable from the client. This is the
acknowledgement-is-not-completion rule in its strongest form: the
acknowledgement never arrives and the operation continues anyway.

**SIGINT waits for creation to stop before deleting.** An interrupt landing
while `growFleet` awaited one batch of a multi-batch step used to snapshot the
cleanup id list at once; the outstanding batch then finished and later batches
were created behind the snapshot. An abort flag is now set first, the sweep is
awaited, and only then is the list read. The flag alone was read only between
steps and batches, so an interrupt during a settle, warmup or measurement wait
delayed every deletion until that wait ended by itself; those waits are now
raced against the interrupt as well. A second Ctrl-C exits immediately and
names what may be left behind.

**The hold starts when the transaction does.** `start_transaction`'s
control-plane ack returns while `ChargePoint.startTransaction` is still awaiting
`Authorize.conf` (`AuthorizeBeforeLocalStart` defaults to **true**), so timing
the hold from the ack made the generated load a function of the CSMS latency
being measured — and, past one hold of authorization delay, made the stop a
no-op that left the transaction running into later cycles. The active axis
therefore opens one dedicated event socket (`events.subscribe`, scope `"*"`,
outside the RPC pool) and waits for `transaction_started` — specifically its
first emission, the one carrying the placeholder id `0`, since 1.6 re-emits the
event with the real id once `StartTransaction.conf` lands and a late conf would
otherwise confirm the _next_ cycle's start. Starts it cannot confirm are counted in the
`unconf.tx` column — a slow CSMS, not a broken one. The wait is bounded by the
daemon's **authorization** timeout (10s, plus slack), never by the hold: at
`--tx-interval 2` the hold is 1s while `authorizeAndWait` may legitimately take
10s, so a hold-length wait declared the start dead while it was still pending,
stopped a transaction that did not exist, and began the next cycle into the
arrival of the old one — which could leave a transaction active or let its event
confirm a newer cycle's waiter. `authorizeAndWait` never rejects (it resolves
`"Accepted"` on timeout), so a start unconfirmed past that bound was genuinely
denied; the wait ends on a definitive answer, and no second cycle for a charge
point begins until the outstanding one is answered, held and stopped. The
resulting drift is **one-way and permanent**: a cycle that waited out a denial
occupies 15s plus a hold and the next is anchored one period after that one
_started_, so at `--tx-interval 2` the charge point stretches from a 2s cycle to
roughly 16s and never catches up. A non-zero `unconf.tx` means those charge
points' cadence is their own rather than the flag's, not merely that the load
was late.
**Losing the socket aborts the run instead:** without confirmations every later
cycle would burn a full hold waiting for one that can never arrive and then the
real hold, roughly doubling each transaction's occupancy and collapsing the
rest period, so the remaining rows would carry about twice the configured load
under the configured load's label. The sweep stops, prints `Aborted:` with the
reason, writes no table and no `--out` file, and exits at once rather than
waiting out the timers it was racing (`Promise.race` does not cancel the loser,
and a measurement sleep runs up to an hour); a deliberate teardown closes
the socket without triggering it. The socket is also opened _inside_ the run's
cleanup scope, so a failure to connect or subscribe closes the control-plane
pool rather than leaving its `reconnection: true` sockets open and the process
alive after the error is printed. The subscription is itself a small
load on the daemon (every charge point's connector-status and transaction
envelopes are encoded and sent to that socket); it is still cheaper than
polling each charge point's `status`, which would add a third RPC per cycle to
the rationed budget below. The idle axis opens no event socket.

**Cleanup deletes what this run created, and refuses to touch anything else.**
An id enters the delete list when it is _offered_ to `cp.create_many`, before
the call is awaited, and leaves it again if the ack names that id as a failure.
The first rule covers the indeterminate case — an RPC deadline does not tell the
daemon to stop, so it may hold charge points whose ids never reached the client,
and `not_found` on a delete already counts as success, so over-listing is free.
The second covers the determinate one: a reported failure is positive evidence
the daemon did not register the charge point, since `createOneCp` throws before
creating anything on an id collision and the blueprint-defaults path rolls back
before reporting. Keeping failed ids was **destructive**: under
`--allow-existing`, a charge point somebody else created that already held an
offered id was reported as failed _because it already exists_, and teardown then
deleted it. The primary fix is that the collision is now unrepresentable — every
run mints a **run id** and creates its charge points as `BENCH-<runid>-000001`,
so no pre-existing charge point can sit on an id this run offers; the run id is
printed on stderr and recorded in `--out`, and the shared `BENCH-` root still
identifies a crashed run's leftovers. The randomness in it is identity, not
behaviour, so the traffic pattern stays deterministic. The asymmetry is deliberate — a kept id leaks,
which is recoverable, while a deleted charge point is not — so an id leaves the
list only on positive evidence that it was never ours. The sweep itself is
best-effort and bounded: 32 concurrently, within a 60s budget. A batch whose
RPC hit its deadline can still have created charge points server-side, and ids
that never reached the client would otherwise be left registered for the next
run's preflight to refuse; `not_found` on a delete counts as success, so
over-listing is free.

if no control-plane socket is connected the sweep is skipped outright, since
socket.io buffers an emit issued while disconnected rather than failing it.
Sequential deletes at the full 35s RPC timeout each turned teardown of a
2000-CP fleet against a dead daemon into hours of blocked failure handling and
an unresponsive Ctrl-C. Whatever is left is named on stderr — the next run's
preflight refuses a daemon that still holds it.

**Credentials are redacted from stderr as well as `--out`.** A result file is
meant to be kept and shared, so the daemon Basic Auth password and any userinfo
embedded in `--csms-url` / `--daemon-url` are written as `***` — and the same
redaction applies to the progress lines, the hardware block and every error
message, because stderr commonly ends up in a CI log. That includes a URL too
malformed to parse: `ws://user:secret@` is the shape that makes `new URL`
throw, and the redaction is a regex over the raw text rather than a URL
rewrite, so it works without one. It scans the whole text rather than only its start — a URL embedded in an
exception (`TypeError: ... https://user:secret@host`) is missed by the anchored
bare-URL helper, and handing a whole message to that helper is how a password
reached stderr once. It also covers the **caught exception text**,
not only the URL printed beside it — a failed `fetch` commonly quotes the
original URL verbatim, so redacting one and appending the other put the
password straight back on the line — and it is applied at every error sink
including the top-level one, since a socket.io connect error can carry the
daemon URL.

**Every HTTP request carries a 30s deadline.** `fetch` has none of its own, so a
daemon that accepts the connection and then stalls while serving `/metrics` —
the condition at the top of a sweep, which is what the tool exists to reach —
used to hang the run forever: `--settle-timeout` never fired, the measurement
never finished and the cleanup in the `finally` never ran. The deadline covers
the response body, not just the headers.

**Two axes**, one per invocation: `--tx-interval 0` (default) measures idle
CPs (heartbeat only — an idle timer any outgoing CALL resets, so this isolates
per-CP timer/scheduling overhead); `--tx-interval N` measures active CPs
(each cycles start/stop transaction roughly every N seconds), the axis the
issue calls "the one that matters".

**Why a socket pool, and the ceiling it imposes.** The control plane
rate-limits each socket.io connection (`RPC_RATE_PER_SEC` / `INFLIGHT_CAP`,
[`src/protocol/limits.ts`](../../src/protocol/limits.ts)) to protect against a
misbehaving client — which would also throttle the benchmark's own
control-plane traffic long before the daemon's OCPP-handling capacity became
the bottleneck. The limit is per connection, so `fleet-bench.ts` opens as many
sockets as the run needs — one per ~200 planned CPs **and** enough for the
transaction rate — capped at 10 and paced at 80 RPC/s each.

The active axis issues two RPCs per charge point per cycle and awaits each
before scheduling the next phase, so a rate above the pool's budget does not
queue: it stretches the cycle, and the run then applies less load than
configured while reporting that smaller load's latency as the configured one's.
`validateOptions` refuses such a run outright, naming the required rate, the
ceiling and the two ways out. Ten sockets at 80 RPC/s with 0.8 headroom is
**640 RPC/s**, so the active axis sustains **N ≤ 320 × `--tx-interval`** for
`--tx-interval ≥ 2` — 640 charge points at 2, the full 2000 at 7 or more; a
`--tx-interval` of 1 really cycles every 2s, since a hold is floored at 1s, and
so has the same 640 ceiling. The headroom is
there because a token bucket at utilisation 1 never drains its jitter, and
because arming and cleanup share the same buckets. The idle axis has no ceiling:
heartbeats are the daemon's own timers and the script issues nothing after
arming.

**Layout.**

- `fleet-bench.ts` — CLI entry point / orchestrator (preflight, fleet growth,
  load, metrics diffing, reporting, cleanup).
- `lib.ts` — pure logic: flag validation, the Prometheus text exposition
  parser, before/after histogram diffing, quantile interpolation, table
  formatting, and rate/concurrency pacing helpers. No network.
- `lib.bun.test.ts` — unit tests for the above.
- `fleetBench.smoke.bun.test.ts` — an end-to-end smoke test that spawns the real
  script against a real daemon and mock CSMS, asserting the run terminates
  inside a hard wall-clock bound, reports both sweep steps, leaves the daemon
  empty, spares a pre-existing charge point under `--allow-existing`, and ends
  even when the CSMS black-holes responses. It exists because the two classes of
  defect that recurred through review — "the process never exits" and
  sweep-level composition — are invariants about the whole run rather than about
  any function, and so are invisible to unit tests. It covers both axes and
  kills the daemon mid-run, and it is gated by `bun run test:bun` in CI. Its
  mock CSMS is deliberately more permissive than a real one — no subprotocol
  negotiation, no schema validation, never a CALLERROR — so a pass there says
  nothing about handshake or version behaviour, which the test file records in
  full.
- `tsconfig.json` — this directory is outside `tsconfig.cli.json`'s
  `include`; typechecked separately, and referenced from the root
  `tsconfig.json` as a `composite` project so `tsc -b` covers it.

**No measured number ships with this tool.** Producing one needs a real CSMS
and a stated machine — neither exists in this repository's CI or review
sandboxes. See
[Daemon → Measured scale ceiling](../entities/daemon.md#measured-scale-ceiling)
for what to record once someone runs it, and
[Roadmap → 5a](../analyses/fleet-load-and-observability-roadmap.md#5a-measured-scale-ceiling)
for how that number gates 5b (a worker model).
