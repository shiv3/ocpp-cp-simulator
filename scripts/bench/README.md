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
  ([SteVe](../steve-verify/README.md), a vendor CSMS staging environment, etc.)

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
N    connected  unsettled  calls  p50  p95   hb p50  hb p95  timeouts  late>30s  errors  reconnects
---  ---------  ---------  -----  ---  ----  ------  ------  --------  --------  ------  ----------
50   50         0          150    6ms  21ms  6ms     21ms    0         0         0       0
250  250        0          750    7ms  22ms  7ms     22ms    0         0         0       0
450  450        0          1350   7ms  23ms  7ms     23ms    0         0         0       0
```

(The `timeouts` / `late>30s` columns replaced a single `>30s` column after that
run; both were zero in it, so the numbers above are the run's own — only the
header changed.)

Flat, as expected: a trivial mock CSMS answering on loopback never saturates,
so this run shows no knee at all — the point of this example is to show the
table shape and confirm the tool works end to end, not to suggest what a real
knee looks like. A real CSMS on real hardware is what would make p50/p95
diverge from this baseline as N grows.

## Flags

| Flag                             | Required | Default         | Meaning                                                                                                                                                                                         |
| -------------------------------- | -------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--csms-url <url>`               | Yes      | —               | CSMS the benchmarked fleet connects to. **`ws://` or `wss://` only** — OCPP-J. An `http(s)://` URL is rejected; see "Known limitations" for why SOAP is out of scope.                           |
| `--daemon-url <url>`             | Yes      | —               | This simulator's daemon control plane (`http(s)://`, no trailing slash needed).                                                                                                                 |
| `--counts <n,n,...>`             | No       | `10,50,100,200` | Ascending, comma-separated fleet sizes to sweep. Each step creates only the delta since the previous step. Capped at 20 points, each ≤ 2000.                                                    |
| `--allow-existing`               | No       | off             | Run even though the daemon already holds charge points. Off by default, and the pre-existing count is recorded in the report and in `--out`. See "Preflight" below.                             |
| `--duration <seconds>`           | No       | `60`            | Measurement window per step, once that step's new CPs have settled. 5–3600. Must be ≥ 2× `--heartbeat-interval`.                                                                                |
| `--heartbeat-interval <sec>`     | No       | `5`             | Heartbeat cadence applied to every CP via `start_heartbeat`, overriding the CSMS's own BootNotification interval so a run is comparable across CSMS peers. 1–3600.                              |
| `--tx-interval <seconds>`        | No       | `0`             | `0` = **idle axis**: heartbeat only. `>0` = **active axis**: each CP cycles `start_transaction`/`stop_transaction` on connector 1 at roughly this period, staggered across CPs.                 |
| `--settle-timeout <seconds>`     | No       | `60`            | How long to wait for a step's newly-created CPs to report connected before measuring anyway. 1–600.                                                                                             |
| `--health-path <path>`           | No       | `/v1/healthz`   | Must match the daemon's own `--health-path` if it was changed.                                                                                                                                  |
| `--daemon-basic-auth-user/-pass` | No       | —               | Basic Auth for a daemon started with `--http-basic-auth-user/-pass` and not `--metrics-no-auth`. Both or neither.                                                                               |
| `--out <path>`                   | No       | —               | Also write the full per-step results (including raw seconds, not just the formatted table) as JSON. Credentials are redacted: the daemon Basic Auth password and any URL userinfo become `***`. |

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
4. **Arm load**, then snapshot `/metrics`, sleep `--duration`, and snapshot
   `/metrics` again. **Every reported number is a delta between those two
   scrapes** — the histogram is a Prometheus cumulative counter that never
   resets, so a single scrape can't isolate one step's traffic from the
   whole daemon's lifetime. See `diffHistogram` in `lib.ts`.
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
   the charge point gave up on, either because the 30s per-CALL watchdog fired
   or because the pending-call map evicted them. **This is the headline knee
   signal.** It is a separate counter and not the histogram's overflow bucket
   for a concrete reason: a duration is only observed when an answer arrives,
   so a CALL the CSMS never answers produces no histogram observation at all —
   a saturated CSMS used to report `>30s=0, errors=0`, the exact opposite of
   the truth.

   **`late>30s`** is the histogram overflow (`+Inf` minus the last finite
   bucket): calls the CSMS _did_ answer, later than the 30s watchdog. A
   different fact from a timeout, and reported as its own column rather than
   passed off as one.

   **`errors`**/**`reconnects`** are deltas of
   `ocppcp_ocpp_call_errors_total`/`ocppcp_ws_reconnects_total`. Together
   these are a sharper knee signal than latency — latency creeping up is
   ambiguous on a loaded CSMS; abandoned calls, CALLERRORs and reconnects on
   the _daemon_ side are not.

   One caveat on attribution: the watchdog fires 30s after the CALL, so a
   timeout for a call sent in the last 30s of a measurement window is counted
   in the **next** step's row. Keep `--duration` at 60s or more (the script
   prints a note if it is not) so the knee lands on the right `N`.

8. **Cleanup.** Every created CP is `cp.delete`d at the end (or on Ctrl-C).
   This script never calls `state.reset` (daemon-wide, drops CPs it didn't
   create too) — run it against a dedicated bench daemon if you want a clean
   slate.

### Why a socket pool

The control plane rate-limits each socket.io connection
(`RPC_RATE_PER_SEC` / `INFLIGHT_CAP` in `src/protocol/limits.ts`) — a real
protection against a single misbehaving client, but it would also throttle
_this script's own_ control-plane traffic (arming N heartbeats, cycling
transactions) long before the daemon's OCPP-handling capacity is the
bottleneck. `fleet-bench.ts` opens one socket per ~200 planned CPs (capped at 10) and paces each below the server limits, so the script's own control
traffic isn't what shows up as the knee. This pacing only affects how fast
CPs get _armed_ — the OCPP wire traffic each triggers (a heartbeat timer, a
StartTransaction/StopTransaction pair) runs asynchronously per CP once armed
and isn't bounded by it.

## Recording a result

Per the acceptance criteria on #302, a real run's result belongs in
[`docs/entities/daemon.md` → Limits & Roadmap](../../docs/entities/daemon.md#limits--roadmap),
recorded as:

- the **machine** (this script prints CPU model/cores, RAM, `bun --version`,
  the daemon's own version — copy that line verbatim),
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
  `wsUrl` and the daemon defaults to `OCPP-1.6J`.
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
