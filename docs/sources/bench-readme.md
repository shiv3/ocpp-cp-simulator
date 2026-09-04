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
interval plus the stagger ramp, which is one interval long on the active axis).
With it, a row's `timeouts` covers exactly the calls issued between 30s before
the window opened and 30s before it closed, all at that step's `N`; calls issued
in the window's last 30s expire during the next step's warmup and are counted in
neither row — dropped, never misattributed. `--warmup 0` opts out for a smoke
run, with a printed note. Latency, `late>30s`, `errors` and `reconnects` do not
depend on it.

**The transaction stagger is evenly spaced, not random.** Charge point `i` of a
step's `count` starts its first cycle `i/count` of a `--tx-interval` in, so two
runs with the same flags issue the same traffic pattern and a knee is
reproducible from the options recorded in `--out` — the project's
"every random behaviour is seeded and replayable" rule, met by having no
randomness at all here. `Math.random()` offsets could also cluster by chance and
move the observed knee.

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

**A row is labelled with the fleet it describes.** `cp.create_many` succeeds
partially, so `N` is the number of charge points that actually exist and
`uncreated` is how many the step's `--counts` entry asked for and did not get.
Reporting the requested size attributed a row's latency to a fleet that never
existed.

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
otherwise confirm the _next_ cycle's start. Starts it cannot confirm within one
hold are counted in the `unconf.tx` column. The subscription is itself a small
load on the daemon (every charge point's connector-status and transaction
envelopes are encoded and sent to that socket); it is still cheaper than
polling each charge point's `status`, which would add a third RPC per cycle to
the rationed budget below. The idle axis opens no event socket.

**Cleanup is best-effort and bounded.** Every charge point id the run _offered_
to `cp.create_many` — not only those it was told were created — is `cp.delete`d
at the end and on Ctrl-C, 32 concurrently and within a 60s budget. A batch whose
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

**`--out` is redacted.** A result file is meant to be kept and shared, so the
daemon Basic Auth password and any userinfo embedded in `--csms-url` /
`--daemon-url` are written as `***`.

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
