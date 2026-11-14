# Dev spike-test runner (`scripts/loadtest-dev/`)

Reproduces a mass reconnect of a realistic OCPP 1.6J fleet against a central
system, with the simulator itself as the engine: a few server-mode daemons
(`bun apps/cli/src/main.ts --http-port …`, one per ~1,000 chargers) driven over
their [Socket.IO control plane](../../docs/concepts/control-plane.md).

Built for the dev reproduction of the 2026-11-05 ocpp-cs freeze: 4,000
chargers `790001..794000`, 2 connectors each, 15 % of them never answer a
CS-initiated CALL, and the CS is restarted by an operator while the fleet is
up.

| File               | What                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `setup-vm.sh`      | Idempotent VM setup: apt (unzip curl git), bun, nofile limit 65536, `bun install` with the `@open-ocpp-trace/*` workaround   |
| `run.ts`           | The runner (spawns the daemons, creates the fleet, ramps, watches, measures, stops)                                          |
| `mute.behavior.ts` | Charger-engine behavior `loadtest-mute`: `noResponse` for every CS→CP action of 1.6J                                         |
| `mockCsms.ts`      | Local mock CS for verification only (Boot/Heartbeat/Status, ChangeConfiguration + TriggerMessage after boot, counts answers) |
| `verify-local.sh`  | Runs the whole schedule against the mock, with a mock restart and a client storm                                             |

## Fresh VM (Debian 12 x86_64, 2 vCPU / 8 GB)

```sh
sudo apt-get update && sudo apt-get install -y git
git clone -b loadtest/dev-spike-runner https://github.com/shiv3/ocpp-cp-simulator.git
cd ocpp-cp-simulator
bash scripts/loadtest-dev/setup-vm.sh
exec bash -l            # pick up ~/.bun/bin on PATH (or: export PATH=$HOME/.bun/bin:$PATH)
ulimit -n 65536         # run.ts also raises it for each daemon
sudo timedatectl set-ntp true; timedatectl | grep synchronized   # the schedule is absolute UTC
```

Optional smoke test against the local mock (no traffic to the CS, ~4 min):

```sh
LEAD=8 STEADY=25 STORM_GAP=60 TAIL_SEC=50 HB=10 WINDOW=15 PER_DAEMON=30 \
  bash scripts/loadtest-dev/verify-local.sh 60 15 /tmp/smoke
```

## The real run

Pick absolute epochs (UTC seconds). Fleet creation takes ~15 s; start the ramp
at least 60 s after launching. Run it in `tmux`/`screen` (or `nohup`), it is
long-lived.

```sh
NOW=$(date +%s)
RAMP_START=$((NOW + 120))            # 5 min ramp -> fleet up at RAMP_START+300
OBSERVE_UNTIL=$((RAMP_START + 300 + 600 + 1800))  # steady 10 min, restart, watch 30 min
echo "ramp $(date -u -d @$RAMP_START) end $(date -u -d @$OBSERVE_UNTIL)"

tmux new -s spike
bun scripts/loadtest-dev/run.ts \
  --url wss://cs.dev-dmm-ev-charge.com/chargepoint/ \
  --first-id 790001 --count 4000 --connectors 2 --per-daemon 1000 \
  --ramp-start "$RAMP_START" --ramp-sec 300 --observe-until "$OBSERVE_UNTIL" \
  --out ~/spike-$(date -u +%Y%m%dT%H%M)
```

The operator restarts ocpp-cs any time after the ramp (`RAMP_START + 300`).
The runner never closes sockets itself; it prints

```
FIRST_CLOSE 2026-11-15T10:00:01.234Z (incident #1: 200 server closes by +0.05 s, 1006 -=200)
RECOVERED_99 incident #1 server-restart: 3961/4000 re-booted 41.2 s after …
WINDOW w14 … hb_ok=97.1% (3299/3400) missed_2_in_a_row=12 incident #1 +40s
STATUS incident1 open=… booted=…/4000 cpu%=…/…/…/… rssMB=… rpcQ=0
```

Without an operator, `--client-storm-at <epoch>` drops every open charger at
that time instead (each then redials with its own profile); it must be after
the ramp and before `--observe-until`. At `--observe-until` the runner stops
the daemons (SIGTERM, which closes the sockets; SIGKILL after 15 s) and checks
that no process and no TCP socket to the target is left (exit 0 when both are
0). Ctrl-C does the same.

Dry run (plan only, no daemons): add `--dry-run`.

### Options

| Option                                 | Default                                       | Meaning                                                                                         |
| -------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `--url`                                | `wss://cs.dev-dmm-ev-charge.com/chargepoint/` | Base URL; the cpId is appended                                                                  |
| `--first-id`, `--count`                | `790001`, `4000`                              | Ids `first-id .. first-id+count-1`                                                              |
| `--connectors`                         | `2`                                           | Connectors per charger                                                                          |
| `--per-daemon`                         | `1000`                                        | Chargers per daemon process (4,000 → 4 daemons)                                                 |
| `--ramp-start`, `--ramp-sec`           | required, `300`                               | Connects spread evenly over the ramp, in a seeded shuffled order                                |
| `--observe-until`                      | required                                      | End epoch: stop everything, write `summary.json`                                                |
| `--client-storm-at`                    | none                                          | Drop all open chargers at this epoch                                                            |
| `--mute-ratio`                         | `0.15`                                        | Chargers that never answer a CS CALL (spread evenly by id)                                      |
| `--aggressive-ratio`, `--flappy-ratio` | `0.10`, `0.10`                                | Redial profiles (rest: normal)                                                                  |
| `--flap-count`, `--flap-after-ms`      | `2`, `2000`                                   | Flappy: after each reconnect of an incident, drop again `flap-count` times, 2 s after the boot  |
| `--hb-window`                          | `65`                                          | Heartbeat health window (s)                                                                     |
| `--base-port`                          | `9710`                                        | Control-plane ports `base-port ..` (loopback only)                                              |
| `--rpc-conns`, `--rpc-rate`            | `4`, `80`                                     | Control connections per daemon and rpc/s per connection (daemon limit: 100 rpc/s, 64 in flight) |
| `--incident-min-closes`                | `20`                                          | Server closes (≥ 5 % of the open fleet, at least this) within 15 s that make an incident        |
| `--tls-ca`                             | none                                          | PEM that replaces the trust store (only for a self-signed test CS)                              |
| `--seed`                               | `1`                                           | Ramp order                                                                                      |

## Fleet model

- Each charger: connect → `BootNotification` → `StatusNotification` for
  connector 0, 1, 2 (`Available`) → `Heartbeat` at the interval of the CS's
  `BootNotification.conf` (the simulator's heartbeat is an idle timer: any CALL
  resets it). The simulator's default "Essential CP Behavior" scenario (plug-in
  on connect) is removed from every connector after `cp.create`.
- **Mute** (15 %): charge points created with `behaviors: ["loadtest-mute"]`;
  every CS→CP CALL gets no answer (`csms_call_completed outcome: NoResponse`).
  Healthy chargers run the default handlers.
- **Redial** (built-in reconnect loop, `transport.reconnect` per charger):
  | Profile                                           | Share | Policy                                                 | Effective waits                                                                               |
  | ------------------------------------------------- | ----- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
  | aggressive                                        | 10 %  | `fixed 3600 ms`                                        | 3.6 s, 3.6 s, …                                                                               |
  | flappy                                            | 10 %  | same, plus 2 drops after each reconnect of an incident | 3.6 s, …                                                                                      |
  | normal                                            | 80 %  | `exponential base 2500, max 5000, jitter 20000`        | first 2.5–22.5 s (mean 12.5 s, the k6 herd's 0–25 s cannot be expressed exactly), then 5–25 s |
  | Jitter is drawn from a stream seeded by the cpId. |
- Client storm and flappy drops use a network-simulation `manual-disconnect`
  rule (`network_sim.disconnect.trigger`), i.e. an unrequested close from the
  station's point of view, so the reconnect policy applies.

## Output (`--out DIR`)

| File              | Content                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runner.log`      | Everything printed (PLAN, STATUS every 15 s, WINDOW, FIRST_CLOSE, RECOVERED_99, SUMMARY)                                                                                                                                                                                                                                                         |
| `plan.json`       | Resolved options, class counts, schedule                                                                                                                                                                                                                                                                                                         |
| `samples.jsonl`   | Every 5 s: open sockets, booted, per-daemon CPU % (of one core) and RSS, runner CPU/RSS, MemAvailable, load                                                                                                                                                                                                                                      |
| `windows.jsonl`   | Per 65 s window after the ramp: share of healthy (non-mute) chargers with a HeartbeatResponse, chargers that missed 2 windows in a row                                                                                                                                                                                                           |
| `closes.jsonl`    | Every close: time, cpId, code, reason, `server` / `runner`                                                                                                                                                                                                                                                                                       |
| `summary.json`    | Incidents (t0, closes by code/reason, time to 50/90/95/99/100 % re-booted and open), Boot/Heartbeat/Status RTT p50/p95/p99 per phase (`ramp`, `steady`, `incidentN`), unanswered CALLs, close reasons incl. `already exists`, top `error` events, CS-initiated CALLs answered by mute vs healthy chargers, CPU/RSS per phase, final socket check |
| `trace-dN.jsonl`  | Every OCPP frame of daemon N ([trace format](../../docs/concepts/trace-format.md)): the raw data for any re-analysis                                                                                                                                                                                                                             |
| `metrics-dN.prom` | Final `/metrics` scrape of daemon N                                                                                                                                                                                                                                                                                                              |
| `daemon-dN.log*`  | Daemon console (log level warn)                                                                                                                                                                                                                                                                                                                  |

Heartbeat windows: the simulator's heartbeat is an idle timer reset by any
CALL, so a mass reconnect puts the fleet's heartbeats in phase; judge with
65 s windows and 2 consecutive misses, not 30 s. If the CS's heartbeat
interval is ≥ the window the percentage is meaningless: the summary prints the
intervals the CS gave in `BootNotification.conf`; raise `--hb-window` to
interval + 5 s.

## Measured against the mock (2026-11-14, bun 1.3.14)

4,000 chargers, 4 daemons × 1,000, 300 s ramp, mock heartbeat 30 s, mock
restart (SIGTERM, 5 s down) and a client storm 4 min later. Run with
`TLS=1 CPUS_RUN=0,1 CPUS_MOCK=2,3 bash scripts/loadtest-dev/verify-local.sh 4000 300`,
i.e. runner + daemons pinned to **2 cores, wss with TLS**; the mock on other cores.

| Phase                  | Daemons CPU (sum, % of one core)                     | Daemons RSS (sum) | Boot RTT p50 / p95 |
| ---------------------- | ---------------------------------------------------- | ----------------- | ------------------ |
| idle after `cp.create` | ~2 %                                                 | 1.1 GB            | –                  |
| ramp (13 connects/s)   | ≤ 62 %                                               | 1.37 GB           | 0 / 1 ms           |
| steady (heartbeats)    | ≤ 48 %                                               | 1.37 GB           | –                  |
| restart burst (~20 s)  | **178 %** (+ runner 22 %: the 2 cores are saturated) | 1.79 GB           | 35 / 86 ms         |
| client storm burst     | 178 %                                                | 1.86 GB           | 14 / 84 ms         |

Runner: ≤ 22 % CPU, ≤ 125 MB RSS. 99 % re-booted 26.4 s after the restart
(dominated by the redial jitter, the same as unpinned on 4 cores: 25.9 s);
heartbeat windows 100 % outside incidents; mute chargers answered 0 of 3,992
CS CALLs, healthy chargers 22,641 of 22,641; 0 sockets and 0 processes left.
Without pinning (4 cores, plain ws) the burst peaks at 244 % with Boot p95 24 ms.

So 2 vCPU / 8 GB holds 4,000 chargers with plenty of memory headroom (~2 GB
used), but the client is CPU-bound for ~20 s during a reconnect burst, which
adds up to ~100 ms to the RTTs measured in that burst (irrelevant next to a
CS freeze of seconds to minutes, but do not read p95 below ~100 ms in a burst
as the CS's). Use 4 vCPU if burst RTTs must be clean. Trace files grow by
~40 MB per daemon per 15 min at a 30 s heartbeat.

## Limits

- Bun on Linux (reads `/proc` for CPU/RSS and for the socket check).
- Keep `--per-daemon` ≤ 1,500.
- The ramp order and redial jitter are deterministic per seed / cpId.
- A charger whose ramp `connect` fails is retried by its reconnect profile.
- `cp.list` is never used (it fails at ~4,000 CPs); state comes from events
  and the trace files.
- Incident detection: ≥ max(20, 5 % of the open fleet) server closes within
  15 s, more than 60 s after the previous incident started. A dial that never
  opens (`1006 Failed to connect`) is counted (`failedDials`) but does not
  start an incident.
