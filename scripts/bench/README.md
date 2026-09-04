# fleet-bench

Measures where per-charge-point overhead starts distorting OCPP timing on one
daemon process (issue [#302](https://github.com/shiv3/ocpp-cp-simulator/issues/302)).
Stands up N charge points against a real CSMS via
[`cp.create_many`](../../docs/concepts/control-plane.md#cpcreate_many--the-batch-fields),
drives heartbeats (and, optionally, transactions) at a configurable rate, and
reads the daemon's [`/metrics`](../../docs/entities/daemon.md#metrics)
endpoint before and after each step to report N vs. p50/p95 OCPP CALL
round-trip latency — so a human can spot the knee.

This is a benchmark, not a test suite: it has no pass/fail assertion, only a
table. See [Fleet, load and observability roadmap →
5a](../../docs/analyses/fleet-load-and-observability-roadmap.md#5a-measured-scale-ceiling)
for how this fits the larger plan, and
[daemon.md → Limits & Roadmap](../../docs/entities/daemon.md#limits--roadmap)
for where a run's result gets recorded.

## Prerequisites

- [`bun`](https://bun.sh)
- A running daemon started with `--metrics` (or `--metrics-no-auth` if you
  don't want to pass Basic Auth to this script): `bun src/cli/main.ts
--http-port 9700 --metrics`
- A CSMS the daemon can reach — [gocpp](../../docs/entities/csms-peers.md#gocpp)
  is what this project's own e2e suite uses; any real OCPP-J CSMS works
  ([SteVe](../steve-verify/README.md), a vendor CSMS staging environment, etc.).
  Point `--ocpp-version` at whatever the CSMS speaks: the fleet is created as
  `OCPP-1.6J` unless told otherwise, and a 2.x-only CSMS rejects every 1.6J
  handshake — which shows up as an unsettled fleet and an empty table, not as
  an error naming the cause.

## Quick start

```bash
bun scripts/bench/fleet-bench.ts \
  --csms-url ws://localhost:8887/ocpp \
  --daemon-url http://127.0.0.1:9700 \
  --counts 10,50,100,200 \
  --duration 60
```

This creates 10 CPs, measures for 60s, grows to 50 (creating 40 more),
measures again, and so on. Progress goes to stderr as each step runs; the
table is printed once, at the end, covering every step.

Here is real output from a local smoke test — `--counts 50,250,450` against
a trivial auto-acking mock CSMS on loopback (not gocpp, not a real machine
for the record, and **not the #302 result**; see "Recording a result"
below):

```
N    uncreated  connected  dropped  unsettled  calls  p50  p95   hb p50  hb p95  timeouts  late>30s  errors  reconnects  unconf.tx
---  ---------  ---------  -------  ---------  -----  ---  ----  ------  ------  --------  --------  ------  ----------  ---------
50   0          50         0        0          150    6ms  21ms  6ms     21ms    0         0         0       0           0
250  0          250        0        0          750    7ms  22ms  7ms     22ms    0         0         0       0           0
450  0          450        0        0          1350   7ms  23ms  7ms     23ms    0         0         0       0           0
```

(The header has changed since that run — `timeouts` / `late>30s` replaced a
single `>30s` column, and `uncreated`, `unconf.tx` and `dropped` were added.
Every added column was zero in this run, so the numbers above are still the
run's own.)

Flat, as expected: a trivial mock CSMS answering on loopback never saturates,
so this run shows no knee at all — the point of this example is to show the
table shape and confirm the tool works end to end, not to suggest what a real
knee looks like. A real CSMS on real hardware is what would make p50/p95
diverge from this baseline as N grows.

## Flags

| Flag                             | Required | Default              | Meaning                                                                                                                                                                                                                                                       |
| -------------------------------- | -------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--csms-url <url>`               | Yes      | —                    | CSMS the benchmarked fleet connects to. **`ws://` or `wss://` only** — OCPP-J. An `http(s)://` URL is rejected; see "Known limitations" for why SOAP is out of scope.                                                                                         |
| `--daemon-url <url>`             | Yes      | —                    | This simulator's daemon control plane (`http(s)://`, no trailing slash needed).                                                                                                                                                                               |
| `--counts <n,n,...>`             | No       | `10,50,100,200`      | Ascending, comma-separated fleet sizes to sweep. Each step creates only the delta since the previous step. Capped at 20 points, each ≤ 2000.                                                                                                                  |
| `--allow-existing`               | No       | off                  | Run even though the daemon already holds charge points. Off by default, and the pre-existing count is recorded in the report and in `--out`. See "Preflight" below.                                                                                           |
| `--duration <seconds>`           | No       | `60`                 | Measurement window per step, once that step's new CPs have settled. 5–3600. Must be ≥ 2× `--heartbeat-interval`.                                                                                                                                              |
| `--heartbeat-interval <sec>`     | No       | `5`                  | Heartbeat cadence applied to every CP via `start_heartbeat`, overriding the CSMS's own BootNotification interval so a run is comparable across CSMS peers. 1–3600.                                                                                            |
| `--tx-interval <seconds>`        | No       | `0`                  | `0` = **idle axis**: heartbeat only. `>0` = **active axis**: each CP cycles `start_transaction`/`stop_transaction` on connector 1 at this period, staggered across CPs. Bounded by the pool ceiling: **N ≤ 320 × `--tx-interval`** (see "Why a socket pool"). |
| `--settle-timeout <seconds>`     | No       | `60`                 | How long to wait for a step's newly-created CPs to report connected before measuring anyway. 1–600.                                                                                                                                                           |
| `--warmup <seconds>`             | No       | `30 + --tx-interval` | How long a step holds the new `N` **and its load** before the first scrape, so the step's `timeouts` are its own. 0–3630. See "Warmup: why a step waits before it measures".                                                                                  |
| `--ocpp-version <version>`       | No       | `OCPP-1.6J`          | OCPP version every benchmarked charge point is created with: `OCPP-1.6J`, `OCPP-2.0.1` or `OCPP-2.1`. The three SOAP versions are rejected, for the same reason `--csms-url` rejects `http(s)://`.                                                            |
| `--health-path <path>`           | No       | `/v1/healthz`        | Must match the daemon's own `--health-path` if it was changed.                                                                                                                                                                                                |
| `--daemon-basic-auth-user/-pass` | No       | —                    | Basic Auth for a daemon started with `--http-basic-auth-user/-pass` and not `--metrics-no-auth`. Both or neither.                                                                                                                                             |
| `--out <path>`                   | No       | —                    | Also write the full per-step results (including raw seconds, not just the formatted table) as JSON. Credentials are redacted: the daemon Basic Auth password and any URL userinfo become `***`.                                                               |

Every flag is bounds-checked before anything is created (`scripts/bench/lib.ts`'s
`validateOptions`) — a bad flag fails before the first charge point exists.

## The two axes

Per the issue, idle and active CPs have very different ceilings, and this
script measures one axis per invocation:

- **Idle** (`--tx-interval 0`, the default): a heartbeat is the only traffic.
  Because the simulator's heartbeat is an _idle timer_ — any outgoing CALL
  resets it (`src/cp/application/services/HeartbeatService.ts`) — this
  isolates pure per-CP scheduling/timer overhead from OCPP call handling.
- **Active** (`--tx-interval N`): each CP also start/stops a transaction on
  connector 1 roughly every `N` seconds, staggered so the fleet reaches
  steady state instead of bursting in lockstep. This is the axis the issue
  calls "the one that matters" — it drives the daemon's actual OCPP call
  handling path, not just timers.

  The stagger is **deterministic, and phased off each charge point's global
  fleet index** — never its index within the step that created it. Two runs
  with the same flags therefore issue the same traffic pattern, so a knee is
  reproducible and a run can be replayed from the options recorded in `--out`
  — the same guarantee the rest of the project's randomness gives by being
  seeded. `Math.random()` offsets could cluster by chance and move the observed
  knee, which this cannot.

  **Why global indices, and why not exact even spacing.** The fleet is grown in
  place, so the load is armed once per step with only that step's new charge
  points. Spacing each cohort evenly across the period _by itself_ restarted
  the phase at 0 for every step: with `--counts 1,2,3` and step durations that
  are multiples of the period, all three charge points ended up in nearly the
  same phase — a burst, and a latency knee belonging to this script rather than
  to the daemon, which is the worst answer a tool whose whole output is a knee
  can give. Exact even spacing cannot survive growth without re-phasing the
  running fleet, which would mean clearing in-flight transaction timers and
  re-issuing `start_transaction` on connectors mid-session.

  So a charge point's phase is fixed once, from its global index, using the
  van der Corput sequence in base 2 (`0, ½, ¼, ¾, ⅛, …`). Its defining property
  is the one grow-in-place needs: _every prefix_ is near-uniform, so the fleet
  is well spread at every step of the sweep and a cohort added later never has
  to disturb one already running. The widest silent stretch is at most `2/n` of
  a period at fleet size `n`, against `1/n` for a perfect ring — and against
  "the entire fleet in one phase" for the per-cohort version. The span is the
  cycle period, not the raw `--tx-interval`: a hold is floored at 1s, so at
  `--tx-interval 1` the period is 2s and spreading over 1s would bunch the
  fleet into half the phase space.

  **The offsets are anchored to a run-wide epoch, not to each cohort's own
  start.** Global indices fix _which_ fraction of the period a charge point
  gets; they say nothing about what that fraction is measured from. Creation,
  settling and heartbeat arming all take variable time, so scheduling each
  cohort's offsets from the moment its own arming finished rotated every cohort
  by an arbitrary amount — and two charge points with well-separated indices
  could still collide in wall-clock phase, reaching the artificial-knee failure
  by another route. Each first cycle is therefore rebased modulo the period
  against one epoch fixed before the first charge point exists, so index `i`
  means the same instant whichever step created it.

Run both and compare:

```bash
bun scripts/bench/fleet-bench.ts --csms-url ... --daemon-url ... --tx-interval 0   # idle
bun scripts/bench/fleet-bench.ts --csms-url ... --daemon-url ... --tx-interval 15  # active
```

## How it works

1. **Preflight.** GETs the daemon's health path and `/metrics` before
   creating anything — a 404 on `/metrics` fails fast with "start the daemon
   with `--metrics`" instead of a confusing empty report at the end of a long
   run. It also **refuses a daemon that already holds charge points**:
   `/metrics` has no `cpId` label by design, so a pre-existing fleet's traffic
   would land in the same histogram as the bench fleet's while the reported `N`
   counts only the charge points this script created — the N-vs-latency curve
   would then not be the curve it claims to be. `--allow-existing` waives the
   refusal and records the pre-existing count in the report and in `--out`.
2. **Grow, don't reset.** Each step creates only the CPs it needs
   (`startIndex` into the running total) via `cp.create_many`, chunked at
   `CP_CREATE_MANY_MAX` (200) per call. The fleet is never torn down between
   steps — recreating it would mean a BootNotification storm at the start of
   every measurement window, and `state.reset` is daemon-wide destructive, so
   this script never calls it.
3. **Settle before measuring.** Polls the `ocppcp_charge_points` gauge until
   at least the expected number of charge points report a state other than
   `"Unavailable"` (or the settle timeout elapses), so boot traffic doesn't
   land inside the measurement window. The gauge, not `cp.list`: `cp.list`'s
   _result_ schema is `ARRAY_1000` (`src/protocol/methods.ts`), so past 1000
   charge points the response fails validation and the RPC answers `internal`
   — which aborted the sweep at exactly the sizes this tool exists to reach.
   The gauge is one bounded number whatever the fleet size, so the documented
   2000-CP cap is a size the sweep can actually run.
4. **Arm load, warm up, then measure.** After the step's new CPs are armed the
   script holds the fleet at this `N` under this load for `--warmup` seconds
   _before_ the first scrape (see "Warmup" below), then snapshots `/metrics`,
   sleeps `--duration`, and snapshots `/metrics` again. **Every reported
   number is a delta between those two scrapes** — the histogram is a
   Prometheus cumulative counter that never resets, so a single scrape can't
   isolate one step's traffic from the whole daemon's lifetime. See
   `diffHistogram` in `lib.ts`.
5. **p50/p95** are computed by linear interpolation within the bucket the
   target quantile falls in — the same approximation Prometheus's own
   `histogram_quantile()` uses. Resolution is bounded by the fixed bucket
   edges (`CALL_DURATION_BUCKETS_SECONDS` in
   `src/cli/server/metrics/MetricsRecorder.ts`, currently up to 30s); a
   quantile inside a wide bucket is only as precise as that bucket is
   narrow. A quantile past the last finite edge is reported as `>30s`
   ("overflow"), never fabricated.
6. **`hb p50`/`hb p95`** are the `Heartbeat` action alone — the constant-cost
   probe, so its drift in isolation is closer to pure per-CP overhead than
   the aggregate column (which, in active mode, is dominated by
   StartTransaction/StopTransaction).
7. **`timeouts`** is the delta of `ocppcp_ocpp_call_timeouts_total` — CALLs
   the charge point's transport gave up on, i.e. the 30s per-CALL watchdog
   fired. Nothing else increments it. **This is the headline knee signal.** It
   is a separate counter and not the histogram's overflow bucket for a concrete
   reason: a duration is only observed when an answer arrives, so a CALL the
   CSMS never answers produces no histogram observation at all — a saturated
   CSMS used to report `>30s=0, errors=0`, the exact opposite of the truth.

   The column reads **`n/a`, not `0`**, on `--ocpp-version OCPP-2.0.1` /
   `OCPP-2.1`: there is no watchdog in the 2.x handler, so nothing there could
   ever move the counter, and a `0` would read as "no calls were abandoned".

   A **correlation-cache eviction is not a timeout** and no longer counts as
   one (it did until #302). The recorder correlates at most 4096 in-flight
   CALLs; past that it drops the oldest, which costs a _duration sample_ and
   says nothing about the CSMS — the transport still holds the call. When
   `ocppcp_ocpp_pending_calls_evicted_total` moves during a window the script
   warns on stderr and records the count in `--out`, because it means that
   row's `p50`/`p95` are computed from fewer observations than the `calls`
   column implies.

   **`late>30s`** is the histogram overflow (`+Inf` minus the last finite
   bucket): calls the CSMS _did_ answer, later than the 30s watchdog. A
   different fact from a timeout, and reported as its own column rather than
   passed off as one.

   **`errors`**/**`reconnects`** are deltas of
   `ocppcp_ocpp_call_errors_total`/`ocppcp_ws_reconnects_total`. Together
   these are a sharper knee signal than latency — latency creeping up is
   ambiguous on a loaded CSMS; abandoned calls, CALLERRORs and reconnects on
   the _daemon_ side are not.

   Attribution is what the warmup below is for: the watchdog fires 30s _after_
   the CALL, so which calls a step's `timeouts` delta covers is a property of
   when the step's load started, not of `--duration`.

   **`connected`/`dropped`.** `connected` is read from the **final** scrape —
   the fleet that actually generated this row's histogram — not from the settle
   poll that ran before the warmup. `dropped` is how many had settled and were
   gone by the end. Reporting the settle-time count attributed a window's
   latency to a fleet larger than the one producing it; a disconnect during the
   _warmup_ is the worst case, because its reconnect attempts land before the
   `before` scrape, so `reconnects` stays 0 and nothing else in the row hints at
   it. A charge point that reconnects inside the window can leave `connected`
   above the settle count, which is reported as `dropped 0` rather than a
   negative number. The script also warns on stderr whenever `dropped` is
   non-zero.

   **`N`/`uncreated`.** `N` is the fleet the row's numbers actually describe,
   **not** the `--counts` entry it was aiming for; `uncreated` is the
   difference. `cp.create_many` succeeds partially, so a step that asked for 10
   and got 8 used to print `N=10, connected=8, unsettled=0` — latency
   attributed to a fleet that never existed. Now it prints `N=8, uncreated=2`.

   **`unconf.tx`** counts transaction starts this step could not confirm: the
   `start_transaction` ack returns while the charge point is still waiting on
   `Authorize.conf`, so the script waits for the daemon's `transaction_started`
   event before timing the hold. It waits **15s — the daemon's own 10s
   authorization timeout plus slack — never the hold**. At `--tx-interval 2`
   the hold is 1s while authorization may legitimately take 10s, so a
   hold-length wait declared the start dead while it was still pending: the
   stop then fired against a transaction that did not exist, the next cycle
   began immediately, and the original start landed _after_ that ineffective
   stop — leaving a transaction active, or letting its event confirm a newer
   cycle's waiter. `authorizeAndWait` never rejects (on timeout it warns and
   proceeds as `Accepted`), so a start still unconfirmed after 15s was
   genuinely denied: the wait ends with a definitive answer rather than a
   guess, and no second cycle for a charge point begins until the outstanding
   one has been answered, held and stopped.

   **The drift this causes is one-way and permanent.** A cycle that had to wait
   out a denial occupies 15s plus a hold, and the next cycle is anchored one
   period after the _start_ of that one — so at `--tx-interval 2` the charge
   point's cycle stretches from 2s to about 16s and is never caught back up. A
   non-zero `unconf.tx` therefore does not mean "the load was fine, just late":
   it means those charge points' cadence is now their own rather than the
   flag's, and the fleet is that much below the configured load from then on.
   That is the honest trade against the alternative — beginning a new cycle
   while the old start is still outstanding, which is the desynchronisation
   this bound exists to prevent. A non-zero value means authorization is taking longer than a hold — a
   knee signal in its own right, and a warning that those cycles applied less
   load than the flags asked for — a slow CSMS, not a broken one, since a lost
   event stream aborts the run rather than filling this column. Unlike every
   other column it is counted in this process, not scraped, so its window is
   step-end to step-end and includes the warmup rather than only `--duration`.

8. **Cleanup, and what it refuses to touch.** Charge points this run created
   are `cp.delete`d at the end (or on Ctrl-C), 32 at a time and **within a 60s
   budget**.

   An id enters the delete list when it is _offered_ to `cp.create_many`,
   before the call is awaited, and **leaves it again if the ack names that id
   as a failure**. The two rules cover two different cases. While the outcome
   is unknown — an RPC deadline, a dropped connection — the daemon was never
   told to stop and may hold charge points whose ids never reached this
   process, so keeping them costs nothing (`cp.delete` answering `not_found`
   already counts as success) while dropping them would leave a daemon the next
   run's preflight refuses. Once the ack names an id as failed we _know_ the
   daemon did not register it: `createOneCp` throws before creating anything on
   an id collision, and the blueprint-defaults path rolls the charge point back
   before reporting it.

   That second rule is not a nicety. Under `--allow-existing`, a charge point
   somebody else created that already held an offered id was reported as failed
   **because it already exists** — and deleting on that basis destroyed a fleet
   this benchmark never created. The asymmetry is deliberate: an id kept by
   mistake leaks, which an operator can recover from, while a charge point
   deleted by mistake cannot be recovered. So an id leaves the list only on
   positive evidence that it was never ours.

   **But the bookkeeping is the second line of defence, not the first.** Every
   run mints a **run id** and creates its charge points as
   `BENCH-<runid>-000001`, `BENCH-<runid>-000002`, … The run id is printed on
   stderr at startup and recorded in `--out`. Because no two runs share an id
   space, a pre-existing charge point _cannot_ be sitting on an id this run
   offers, so "the benchmark deleted something it did not create" is not a case
   that has to be reasoned about correctly — it cannot arise. Anything left
   behind by a crashed run is still recognisable by the shared `BENCH-` root,
   which is what the preflight's refusal is asking you to clear.

   The randomness in a run id is _identity_, not behaviour: it names charge
   points and never influences the traffic pattern, so the stagger, the cycle
   and every other observable stay deterministic and replayable. It is best-effort, so it is
   bounded: deleting sequentially with the full 35s RPC timeout each meant a
   daemon that had died turned teardown of a 2000-CP fleet into ~19 hours of
   blocked failure handling and an unresponsive Ctrl-C. If no control-plane
   socket is connected the sweep is skipped outright — socket.io _buffers_ an
   emit issued while disconnected rather than failing it, so those deletes
   would each sit in the buffer until their timeout fired. Whatever is left is
   named on stderr, because the next run's preflight refuses a daemon that
   still holds it. This script never calls `state.reset` (daemon-wide, drops
   CPs it didn't create too) — run it against a dedicated bench daemon if you
   want a clean slate.

### Warmup: why a step waits before it measures

`ocppcp_ocpp_call_timeouts_total` increments when a CALL's 30s watchdog fires,
which is 30s **after** the CALL was sent. A step's `timeouts` number is the
delta between the two scrapes bracketing its window, so it counts watchdogs
that fired in that window — that is, calls issued in the 30s-earlier interval.
Without a warmup those calls were issued during the _previous_ step, or during
this step's boot and stagger ramp, at a smaller `N` and a different load. The
first non-zero `timeouts` then showed up one step late, and finding the `N`
where it first goes non-zero is the entire point of the sweep.

So each step holds the fleet at its new `N`, with its load already running, for
`--warmup` seconds before taking the `before` scrape. The default is
`30 + --tx-interval`: one CALL watchdog, plus the stagger ramp, because on the
active axis the last charge point issues its first StartTransaction one cycle
period after the first one does. (Precisely: one _cycle period_, which is
`--tx-interval` for every interval of 2s or more and 2s below that, and zero on
the idle axis, which starts no transactions and so has nothing to ramp.)

**What a row's `timeouts` covers, precisely:** every watchdog expiry between
the two scrapes — i.e. every CALL issued between 30s before the window opened
and 30s before it closed. With the default warmup all of those calls were
issued at this step's `N`, under this step's load. Calls issued in the last 30s
of the window expire during the _next_ step's warmup, outside both windows, and
are counted in neither row: dropped, never misattributed. `--warmup 0` opts out
for a quick smoke run; the script prints a note saying the attribution
guarantee no longer holds. The `p50`/`p95`, `late>30s`, `errors` and
`reconnects` columns do not depend on the warmup — a duration is observed the
moment the answer arrives.

The warmup costs `--warmup` seconds per sweep point, on top of settling and
`--duration`.

### Why a socket pool

The control plane rate-limits each socket.io connection
(`RPC_RATE_PER_SEC` / `INFLIGHT_CAP` in `src/protocol/limits.ts`) — a real
protection against a single misbehaving client, but it would also throttle
_this script's own_ control-plane traffic (arming N heartbeats, cycling
transactions) long before the daemon's OCPP-handling capacity is the
bottleneck. The limiter is **per connection** (`SocketRpcState` in
`src/cli/server/socketServer.ts`), so the pool's budget grows with the socket
count. `fleet-bench.ts` opens as many sockets as the run needs — one per ~200
planned CPs **and** enough for the transaction rate — capped at 10, and paces
each at 80 RPC/s, below the server's 100.

**The sustainable ceiling, and why a run is refused rather than throttled.**
On the idle axis the script issues nothing after arming: heartbeats are the
daemon's own timers. On the active axis it issues two RPCs per charge point per
cycle, and `cycle` awaits each RPC before scheduling the next phase — so a
required rate above the pool's budget does not queue, it _stretches the cycle_.
The fleet then runs at a longer interval than `--tx-interval` says, and the
table reports the latency of that smaller load as if it were the configured
one. Sizing the pool by CP count alone was enough to cause this: 200 CPs fit on
one socket, but at `--tx-interval 2` they demand 200 RPC/s and one socket
allows 64.

So the pool is sized by rate too, and `validateOptions` **refuses** what ten
sockets still cannot sustain, naming the numbers and the two ways out. Ten
sockets × 80 RPC/s × 0.8 headroom = **640 RPC/s**, i.e.

> **N ≤ 320 × `--tx-interval`**, for `--tx-interval ≥ 2` — 640 CPs at 2, 1600
> at 5, the full 2000 at 7 or more. (`--tx-interval 1` really cycles every 2s,
> because a hold is floored at 1s, so its ceiling is 640 as well.)

The 0.8 is not a fudge factor: a token bucket driven at exactly its refill rate
is a queue at utilisation 1, where jitter accumulates into a backlog that never
drains. The remaining fifth also covers the step's own `start_heartbeat` arming
and the end-of-run `cp.delete` sweep, which share the same buckets. A benchmark
that refuses to run beats one that quietly measures something else.

Beyond those RPCs, the OCPP wire traffic each triggers (a heartbeat timer, a
StartTransaction/StopTransaction pair) runs asynchronously per CP and isn't
bounded by this pacing. One further connection sits outside the pool: on the
active axis the script opens a **single dedicated event socket**
(`events.subscribe`, scope `"*"`) to learn when a transaction has actually
started. It spends none of the pool's rate budget, and it is opened _before the
first charge point exists_ — the subscribe ack carries a whole-fleet snapshot
through an `ARRAY_1000` schema, so subscribing later in a 2000-CP sweep would
fail. It does not reconnect: room membership is per-connection server-side, so
a re-subscribe would hit that same cap.

**A drop therefore aborts the run**, and deliberately so. With no way to
confirm a start, every later cycle would spend a full hold waiting for a
confirmation that can never arrive and _then_ the real hold — roughly doubling
each transaction's occupancy and collapsing the rest period, so the remaining
rows would carry about twice the configured load while still being labelled
with it. That is the same failure as running past the pool's rate ceiling, and
it gets the same answer: the sweep stops, prints `Aborted:` with the reason,
writes no table and no `--out` file, and **exits** — the timers it was racing
(a measurement sleep runs up to an hour) are not waited out, because a stop
that does not stop is not a stop. Rows already completed are discarded
with it — a truncated sweep invites a wrong knee, and re-running is cheap next
to recording one. The daemon going away is the only thing that causes this;
the script's own teardown closes the socket without triggering it.

## Recording a result

Per the acceptance criteria on #302, a real run's result belongs in
[`docs/entities/daemon.md` → Limits & Roadmap](../../docs/entities/daemon.md#limits--roadmap),
recorded as:

- the **machine** — but read the label the script prints before copying it.
  `os.cpus()`, `os.totalmem()` and `Bun.version` describe the process running
  _this script_, which is the machine under test only when the daemon is local.
  With a local `--daemon-url` the block says `machine (daemon host, and this
runner):` and can be copied verbatim. With a remote one it says
  `benchmark client, NOT the daemon host:` and `daemon host: UNKNOWN`, and you
  must record the daemon host's CPU/RAM/OS by hand — a ceiling published against
  the wrong hardware is quotable and false, which is worse than one published
  with the hardware missing. `--out` carries the same distinction as a boolean,
  `daemonHostIsRunner`,
- the **CSMS** used (gocpp / SteVe / other, and whether it was local or
  remote — a remote CSMS's own latency will dominate long before the daemon's
  does, which is a different, also worth-recording, knee),
- the **N, p50, p95 table** for both axes, and
- the **knee** — the N where p50/p95 visibly diverges from the N=1..a few
  baseline, or where `timeouts`/`errors`/`reconnects` first go non-zero.

This script cannot produce that number itself (no CSMS is available in this
repo's CI or review sandboxes) — running it is a manual step for whoever has
a spare machine and a CSMS.

## Known limitations

- **SOAP is out of scope, and `--csms-url` rejects `http(s)://` rather than
  pretending otherwise.** The duration histogram is OCPP-J only
  (`ocppcp_ocpp_call_duration_seconds` has no SOAP equivalent — a SOAP log line
  carries no message id to correlate a response back with; see
  `docs/entities/daemon.md#metrics`), so a SOAP fleet would produce an empty
  latency table. An `http(s)://` URL used to be accepted and then quietly run
  a 1.6J WebSocket fleet, because `cp.create_many` was only ever passed
  `wsUrl` and the daemon defaults to `OCPP-1.6J`. `--ocpp-version` rejects the
  three SOAP versions (`OCPP-1.2`, `OCPP-1.5`, `OCPP-1.6S`) for the same
  reason, rather than accepting one and reporting a table of dashes.
- **On OCPP 2.x there is no `timeouts` column at all.** The 30s per-CALL
  watchdog lives only in the OCPP-1.6J message handler
  (`docs/entities/daemon.md#metrics`); `OCPPMessageHandlerV201` has none, and
  nothing else feeds `ocppcp_ocpp_call_timeouts_total`. So on
  `--ocpp-version OCPP-2.0.1` / `OCPP-2.1` the column reads `n/a` and the
  script prints a note saying so. Use `late>30s`, `errors` and `reconnects` as
  the knee signals there; they are unaffected, as is the warmup. (Before #302
  the pending-call eviction path also incremented that counter, which made this
  column look populated on 2.x while actually reporting how full the daemon's
  correlation cache was.)
- **The event socket is itself a small load on the daemon.** Confirming
  transaction starts means subscribing to the `"*"` scope, so the daemon
  encodes and sends every charge point's `connector_status`,
  `transaction_started`/`transaction_stopped` and registry-`updated` envelope
  to one extra socket — a few thousand events per second at the top of an
  active sweep. That is a real perturbation of the thing being measured, and it
  is still the cheaper option: the alternative, polling each charge point's
  `status`, would add a third RPC per cycle to the very budget the ceiling
  above rations, and each of those builds a full per-connector snapshot. The
  idle axis opens no event socket at all.
- **Every HTTP request carries a 30s deadline**, because `fetch` has none of
  its own. A daemon that accepts the connection and then stalls while serving
  `/metrics` — the condition at the top of a sweep, which is what this tool
  exists to reach — would otherwise hang the run forever: `--settle-timeout`
  would never fire, the measurement would never finish, and the cleanup in the
  `finally` would never run. The deadline covers the response body, not just
  the headers.
- **Credentials are redacted from stderr, not only from `--out`.** Userinfo in
  `--daemon-url` is replaced with `***` in the progress lines, the hardware
  block and error messages, because stderr commonly ends up in a CI log.
- `/metrics` is scraped every 500ms during settle-wait. That is one bounded
  HTTP response whatever the fleet size, and it is HTTP rather than
  control-plane traffic, so it is not paced through the socket pool.
- `timeouts` and every other number is fleet-wide, not per charge point:
  `/metrics` carries no `cpId` label by design. That is why the preflight
  refuses a daemon with a pre-existing fleet.
- No MeterValues are driven during a transaction — set
  `MeterValueSampleInterval` on the CPs' config if you want that traffic
  included (not currently a flag on this script).

## Directory layout

- `fleetBench.smoke.bun.test.ts` — an end-to-end smoke test that spawns the
  real script as a subprocess against a real daemon and a real mock CSMS. It
  exists because two classes of defect in this tool are invisible to unit
  tests: **"the process never exits"** (a pool left connected, a timer set that
  grew without bound, an uncancelled `Promise.race` loser, an unbounded
  `fetch`) and **sweep-level composition** (a function correct in isolation
  that breaks across steps or against pre-existing daemon state). Both recurred
  repeatedly during review; the stagger is the proof, since a _tested_ `lib.ts`
  function broke twice in how `main()` called it. The test asserts the run
  terminates inside a hard wall-clock bound, that both sweep steps are reported
  with the fleet size they describe, that the daemon is left empty, that a
  pre-existing charge point survives an `--allow-existing` run, and that a
  black-holing CSMS still ends the run. It covers the **active axis** too, so
  the event socket, the transaction cycle and `unconf.tx` are exercised and not
  only the idle heartbeat path, and it kills the daemon mid-run to check the
  pool does not hang on a control plane that has gone away. It runs under
  `bun run test:bun`, so CI gates on it; it is the slowest file in that suite,
  which is the price of covering the thing that actually broke.

  **Its mock CSMS is far more forgiving than a real one, and the test file says
  so at length.** It does no subprotocol negotiation, no schema validation and
  never emits a CALLERROR, and it acks unknown actions — so the very failure
  this README warns about hardest, a 1.6J fleet against a 2.x-only CSMS,
  _cannot_ be reproduced there: gocpp reports that fleet `Unavailable` while
  the mock reports it `Available`, and the `errors` column can only ever read 0. Version and handshake behaviour must be checked against a real CSMS.

- `fleet-bench.ts` — the CLI entry point / orchestrator.
- `lib.ts` — pure logic: flag validation, the Prometheus exposition parser,
  before/after histogram diffing, quantile interpolation, table formatting,
  and the token-bucket/semaphore pacing helpers. No network, no sockets — see
  `lib.bun.test.ts`.
- `lib.bun.test.ts` — unit tests for the above (`bun test`).
- `tsconfig.json` — this directory isn't part of `tsconfig.cli.json`; typecheck
  it directly with `npx tsc --noEmit -p scripts/bench/tsconfig.json`. It is a
  `composite` project referenced from the root `tsconfig.json`, so `tsc -b`
  covers it too rather than leaving it orphaned.
