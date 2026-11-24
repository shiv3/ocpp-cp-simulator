---
title: Distributed load tests with the k6 operator
type: analysis
summary: How to run an export-k6 bundle over many machines with the Grafana k6 operator on Kubernetes — one TestRun, execution segments that keep charger ids disjoint, aggregated metrics through Prometheus remote write or OpenTelemetry, and the measured sizing (about 2 MB and 0.6 ms per message per charge point). Untested on a real cluster.
sources:
  - "issue #1126"
  - apps/cli/src/exportK6/
  - packages/k6-host/src/ids.ts
  - packages/k6-host/src/config.ts
  - scripts/verify/k6/smoke.ts
related:
  - ../entities/cli.md
  - fleet-load-and-observability-roadmap.md
  - ocpp-protocol-stack.md
updated: 2026-11-24
---

# Distributed load tests with the k6 operator

[`export-k6`](../entities/cli.md#export-k6) turns a scenario into a k6 test that runs the simulator's own engine for
every virtual charge point (#1126). A charge point of that engine costs about 2 MB and 0.6 ms of CPU per OCPP message
(see [Sizing](#sizing)), so one machine holds a few thousand at most. This project does not try to make the station
thinner: **scale comes from running k6 distributed**, with the
[k6 operator](https://github.com/grafana/k6-operator) on Kubernetes. The same works without Kubernetes: any number of
k6 processes started with complementary `--execution-segment`s.

> **Status: not run on a real cluster.** What is verified is the part this repository owns: two k6 v2.4.0 processes on
> complementary execution segments of one test create disjoint charge point ids and run the scenario to completion
> against the mock CSMS (`scripts/verify/k6/smoke.ts --segments 2`, in CI). The `TestRun` manifest, the runner image
> and the metrics wiring below follow the k6 operator and k6 documentation and have not been applied to a cluster; treat
> them as a starting point and expect to adjust.

## How the fleet is split

The generated `script.js` declares one scenario, `per-vu-iterations` with `vus = ceil(CHARGERS / CHARGERS_PER_VU)`,
one iteration per VU. Each VU drives `CHARGERS_PER_VU` charge points. The charge point index is derived from k6's
**test-wide** VU id (`exec.vu.idInTest`), not from a per-instance counter:

```
index = (vu.idInTest - 1) * CHARGERS_PER_VU + slot        # 0-based, global
id    = <CP_ID_PREFIX><index + 1 + CP_ID_OFFSET, zero-padded to CP_ID_PAD>
```

`--execution-segment` (which the operator sets for you from `parallelism`) hands each instance a disjoint range of VUs
and allocates `idInTest` consistently, so no two instances run the same index. Rules that follow:

- Give **every instance the same script and the same environment**, above all `CHARGERS` (the whole fleet) and
  `CHARGERS_PER_VU`. Changing either on one instance breaks the disjointness.
- `CHARGERS` is the whole test, not per pod: 5,000 chargers on `parallelism: 5` are 1,000 per pod.
- Use `CP_ID_OFFSET` to keep two tests against one CSMS apart.
- With `CP_IDS_FILE` the file must have at least `CHARGERS` entries; ids and Basic passwords are taken by global index.

Without the operator, the same split by hand (two machines):

```shell
SEQ=0,1/2,1
CSMS_URL=wss://csms.example.com/ocpp CHARGERS=2000 DURATION=10m \
  k6 run --execution-segment 0:1/2 --execution-segment-sequence $SEQ script.js     # machine A
CSMS_URL=wss://csms.example.com/ocpp CHARGERS=2000 DURATION=10m \
  k6 run --execution-segment 1/2:1 --execution-segment-sequence $SEQ script.js     # machine B
```

## 1. Package the export in a runner image

The bundle is several files (`script.js`, `engine.js`, `scenario.json`, `behaviors/`), and a `ConfigMap` holds one
script. Bake the export into a runner image and point the operator at it with `localFile`:

```dockerfile
FROM grafana/k6:2.4.0
COPY --chown=k6 loadtest/ /test/
```

```shell
ocpp-cp-sim export-k6 --scenario charge.json -o loadtest/
docker build -t registry.example.com/ocpp-load:charge-1 .
docker push registry.example.com/ocpp-load:charge-1
```

(The ~0.9 MB `engine.js` is above the 1 MiB ConfigMap limit once the scenario and behaviors are added, which is the
other reason for the image. A `PersistentVolumeClaim` with `script.volumeClaim` works too.)

## 2. The `TestRun`

```yaml
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: ocpp-charge
spec:
  parallelism: 5 # k6 instances; the operator adds --execution-segment for each
  script:
    localFile: /test/script.js
  arguments: --out experimental-prometheus-rw --tag testid=charge-1
  runner:
    image: registry.example.com/ocpp-load:charge-1
    env:
      - { name: CSMS_URL, value: "wss://csms.example.com/ocpp" }
      - { name: CHARGERS, value: "5000" } # the whole fleet, the same on every pod
      - { name: CHARGERS_PER_VU, value: "50" }
      - { name: PROFILE, value: "steady" }
      - { name: DURATION, value: "30m" }
      - { name: RAMP_DURATION, value: "5m" }
      - { name: GOMAXPROCS, value: "2" } # see Sizing
      - {
          name: K6_PROMETHEUS_RW_SERVER_URL,
          value: "http://prometheus.monitoring:9090/api/v1/write",
        }
      - { name: K6_PROMETHEUS_RW_TREND_STATS, value: "p(95),p(99),avg,max" }
    resources:
      requests: { cpu: "1500m", memory: "1.5Gi" }
      limits: { cpu: "2", memory: "2Gi" }
```

`parallelism: 5` with 5,000 chargers at 50 per VU is 100 VUs split 20 per pod, 1,000 chargers per pod, about 2 GB and
0.7 cores each (see below). Set memory limits with headroom: a pod killed by the OOM killer takes its chargers with it,
and the CSMS sees a thousand disconnects.

Notes:

- The runner starts only after the operator's initializer pod has checked the script, so a broken bundle fails early.
  With `localFile` the initializer needs the same image.
- A `CHARGERS` that does not divide evenly is fine: the last VU gets fewer chargers, and a slot beyond the fleet is
  skipped.
- `PROFILE=soak` holds connections until `DURATION`; `once` runs the scenario one time per charger and ends. The k6
  `maxDuration` of the generated scenario is `RAMP_DURATION + DURATION + 60 s`.
- `wss://` with a private CA: mount the CA bundle and set `SSL_CERT_FILE` (or k6's `insecureSkipTLSVerify` in
  `options`). Per-charger client certificates are not possible: k6 configures `tlsAuth` per domain (see the export's
  README).

## 3. Aggregated metrics

Each k6 instance sees only its own samples; the end-of-test summaries are per pod. For one view of the fleet, stream
every instance's metrics to a backend and aggregate there.

**Prometheus remote write** (`--out experimental-prometheus-rw`, `K6_PROMETHEUS_RW_SERVER_URL`). It works in k6 v2.4,
which warns that the output is deprecated and planned for removal in v3. Enable the remote-write receiver on Prometheus
(`--web.enable-remote-write-receiver`). Set `K6_PROMETHEUS_RW_TREND_STATS` (above) to publish the trend statistics you
alert on, and tag every run (`--tag testid=...`) so runs can be told apart. Counters add up across instances with
`sum(rate(k6_ocpp_calls_total[1m]))`; for trends use the per-instance `p95` series and take the max across instances
(`max(k6_ocpp_call_duration_p95)`), since a percentile of percentiles is not a percentile.

**OpenTelemetry** (`--out opentelemetry`, `K6_OTEL_GRPC_EXPORTER_ENDPOINT`, `K6_OTEL_EXPORTER_PROTOCOL`, ...) is the
output k6 recommends instead; it is the way forward when `experimental-prometheus-rw` goes away.

The export's own metrics are listed in [CLI → export-k6](../entities/cli.md#metrics):
`ocpp_calls` / `ocpp_errors` / `ocpp_call_duration` by `action`, `ocpp_csms_calls`, `ocpp_boot_time`,
`ocpp_scenario_cycles`, `ocpp_scenario_duration`, `scenario_success`, plus k6's own `ws_*` metrics. Check the series
names your backend gives them (Prometheus appends `_total` and replaces dots); this page's queries are examples.

The `scenario_success` threshold (`rate>0.99`) is evaluated **per instance**, on that pod's own samples; a pod that
breaks it exits non-zero, which the operator is expected to report as a failed run.

## Sizing

Measured on k6 v2.4.0 on a 20-core Linux box with the lean OCPP 1.6J bundle, a scenario that loops Authorize →
StartTransaction → MeterValues (5 s) → StopTransaction, `ws://` to a Go CSMS (our own measurements, not a guarantee for
your CSMS, your scenario or `wss://`):

| Quantity                               | Measured                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Memory per running charge point        | **~2 MB** (1,000 chargers, 10 VUs of 100: 1.9-2.0 GB RSS; 200 chargers 410-440 MB)                            |
| CPU per OCPP message (sent + received) | **~0.6 ms** at 1,000 chargers (0.70 cores for 1,155 msg/s, `GOMAXPROCS=2`); 0.445-0.50 ms with `GOMAXPROCS=1` |
| First VU / each further VU             | ~70-100 MB / ~7-15 MB (the bundle is evaluated once per VU, which is why VUs should hold many chargers)       |
| Idle connected fleet                   | 200 chargers about 0.004 cores                                                                                |
| Reconnect after a CSMS restart         | 20 of 20 chargers back and re-booted within 5 s                                                               |
| Bundle                                 | 0.9 MB (the full engine is 3.8 MB; OCPP 2.x schemas, X.509 and SOAP are left out)                             |

Rules of thumb for planning:

- **Chargers per VU: 50 to 100.** One VU is one JavaScript thread; 200 in one VU was 20-25 % slower per message, and
  25 or fewer wastes 7-15 MB of VU overhead per 25 chargers. Do not go to 1 per VU (tens of MB per charger: every VU evaluates the whole bundle).
- **Memory per pod** ≈ 100 MB + 2 MB × chargers. 1,000 chargers per pod is a 2 GB pod; 500 is 1.1 GB.
- **CPU per pod** ≈ 0.6 ms × messages per second. A charger cycling a transaction every 15 s with 5 s meter values is
  about 1 message per second; a heartbeat-only charger is far less. 1,000 busy chargers need about one core of
  steady work; give the pod two for GC and bursts.
- **Go runtime knobs** (environment of the runner):
  - `GOMAXPROCS`: k6's GC mark workers spin on idle cores; limiting them removed about 15 % of CPU at the same memory
    (`GOMAXPROCS=1` for a 200-charger pod, `2` for 1,000). Set it to the pod's CPU limit, not the node's core count.
  - `GOGC`: lowers memory at a CPU price (`GOGC=50`: 200 chargers 365 MB at 0.645 ms/message; `GOGC=30`: 339 MB at
    0.79 ms). `GOMEMLIMIT` just below the pod limit is a safer way to cap memory than a low `GOGC`.
- **Ramp** connects with `RAMP_DURATION` (starts are spread evenly over it); a CSMS that falls over under a connect
  storm is a finding, but not one you want from a misconfigured load test. The ramp rate was not measured.

Per message and per charger, this is 3-8 times the cost of the hand-written runtime this export replaced. That was
accepted so that there is one engine to maintain (#1126); the answer to a bigger fleet is more pods, not a thinner
station. Nothing here has been measured above 1,000 chargers per k6 process or over a real network to a remote CSMS.

## Checklist

1. `ocpp-cp-sim export-k6 ...`, run the export once on a laptop against a local CSMS (`CHARGERS=2 PROFILE=once`).
2. Build and push the runner image; pin the k6 version.
3. Size the pods from the rules above; set `GOMAXPROCS`; set memory limits with headroom.
4. One `TestRun`, `parallelism` pods, the same `env` for all, `CHARGERS` for the whole fleet.
5. Metrics to Prometheus or an OTLP collector, tagged with the run id.
6. After the run, check the CSMS saw `CHARGERS` distinct ids and no id connected twice.
