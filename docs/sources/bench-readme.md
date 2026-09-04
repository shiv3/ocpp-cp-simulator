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

**OCPP-J only.** `--csms-url` takes `ws://` or `wss://` and **rejects
`http(s)://`**. `ocppcp_ocpp_call_duration_seconds` has no SOAP equivalent (a
SOAP log line carries no message id to correlate a response with), so a SOAP
fleet would produce an empty latency table; accepting an HTTP URL used to
quietly run a 1.6J WebSocket fleet instead.

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

**`--out` is redacted.** A result file is meant to be kept and shared, so the
daemon Basic Auth password and any userinfo embedded in `--csms-url` /
`--daemon-url` are written as `***`.

**Two axes**, one per invocation: `--tx-interval 0` (default) measures idle
CPs (heartbeat only — an idle timer any outgoing CALL resets, so this isolates
per-CP timer/scheduling overhead); `--tx-interval N` measures active CPs
(each cycles start/stop transaction roughly every N seconds), the axis the
issue calls "the one that matters".

**Why a socket pool.** The control plane rate-limits each socket.io
connection (`RPC_RATE_PER_SEC` / `INFLIGHT_CAP`,
[`src/protocol/limits.ts`](../../src/protocol/limits.ts)) to protect against a
misbehaving client — which would also throttle the benchmark's own
control-plane traffic long before the daemon's OCPP-handling capacity became
the bottleneck. `fleet-bench.ts` opens one socket per ~200 planned CPs
(capped at 10), each paced under those server limits, so the script's own
control traffic is not what shows up as the knee.

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
