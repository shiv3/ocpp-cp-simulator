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
defaults.

**Method.** Grows the fleet in place via `cp.create_many` (never
`state.reset` — that is daemon-wide destructive), waits for each step's new
CPs to settle, then diffs two `/metrics` scrapes bracketing a measurement
window to isolate that step's `ocppcp_ocpp_call_duration_seconds` histogram
from the daemon's whole-lifetime cumulative counters. p50/p95 come from
linear interpolation within the bucket the target quantile falls in (the same
approximation Prometheus's `histogram_quantile()` uses); a quantile past the
last finite bucket edge (30s) is reported as `>30s`, never fabricated.

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
  `include`; typechecked separately.

**No measured number ships with this tool.** Producing one needs a real CSMS
and a stated machine — neither exists in this repository's CI or review
sandboxes. See
[Daemon → Measured scale ceiling](../entities/daemon.md#measured-scale-ceiling)
for what to record once someone runs it, and
[Roadmap → 5a](../analyses/fleet-load-and-observability-roadmap.md#5a-measured-scale-ceiling)
for how that number gates 5b (a worker model).
