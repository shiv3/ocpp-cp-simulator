// Slow-path tests for `fleet-bench.ts` teardown (issue #330).
//
// WHY A SEPARATE FILE, AND A NAME `test:bun` DOES NOT MATCH. The smoke suite's
// mock CSMS answers at once, and the teardown guards below only engage when
// something is slow — so removing any of them used to leave every test green.
// These cases make the CSMS slow on one action, which costs wall-clock by
// construction. `package.json`'s `test:bun` is `bun test bun.test`, a
// substring filter, and this name avoids that substring on purpose: the file
// runs only through `bun run test:bench-slow`, in its own CI job, so the
// default suite does not pay for it.
//
// HOW EACH CASE IS TIMED. Teardown is entered by SIGINT, sent from the mock's
// own hooks at a known point of the transaction cycle, rather than by waiting
// for the measurement window to end at some unknown phase of it. The SIGINT
// path runs the same `cleanup()` a finished sweep runs, then exits 130.
//
// TWO KINDS OF SLOW. A mock CSMS can slow the CSMS-side stages of a cycle
// (Authorize, StartTransaction, StopTransaction) but not the control-plane
// RPCs: the daemon acks `start_transaction` before Authorize is answered and
// `stop_transaction` once the frame is queued, and its `cp.create_many`
// handler does not wait for the charge point to connect. So the second
// describe block puts a relay between the bench and the daemon
// (`startSlowControlPlane`) that holds chosen RPC *requests*: the daemon then
// acts late, after the bench may have given up, which is what a slow handler
// looks like (#523). That is what reaches the RPC stage of `cycleBoundMs`, the
// wait for an in-flight `cp.create_many`, and the `not_found` reconciliation.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io } from "socket.io-client";

import {
  cpIdsVia,
  listCpIds,
  RELAY_UPSTREAM_CLOSED,
  serveSocketIo,
  startBench,
  startDaemon,
  startMockCsms,
  startSlowControlPlane,
  withControlPlane,
  type Daemon,
  type MockCsms,
  type RelayedRpc,
  type RunningBench,
  type SlowControlPlane,
} from "./smokeHarness.ts";

/** Exit code of the bench's SIGINT path: `cleanup()` ran, then `exit(130)`. */
const SIGINT_EXIT = 130;

/** One charge point on the active axis, against `csmsUrl`, with no
 *  measurement window short enough to end the run before the SIGINT the case
 *  sends. A 30s heartbeat keeps Heartbeats out of the 1.6 serial queue while
 *  a conf is held back, so nothing but the cycle under test is queued behind
 *  it. */
function benchArgs(
  csmsUrl: string,
  daemonUrl: string,
  outDir: string,
  txIntervalSec: number,
): string[] {
  return [
    "--csms-url",
    csmsUrl,
    "--daemon-url",
    daemonUrl,
    "--counts",
    "1",
    "--tx-interval",
    String(txIntervalSec),
    "--duration",
    "60",
    "--heartbeat-interval",
    "30",
    "--warmup",
    "0",
    "--settle-timeout",
    "10",
    "--out",
    join(outDir, "unused.json"),
  ];
}

/** A mock or relay hook that interrupts the bench the first time `name` is
 *  seen. `getBench` is read at call time: the bench starts after the hook is
 *  registered. */
function sigintOnFirst(
  name: string,
  getBench: () => RunningBench | null,
): (call: { action?: string; method?: string; nth: number }) => void {
  return ({ action, method, nth }) => {
    if ((action ?? method) === name && nth === 1) {
      getBench()?.proc.kill("SIGINT");
    }
  };
}

describe("the slow mock CSMS itself (#330)", () => {
  it("delays one action and stalls another after N calls", async () => {
    const csms = startMockCsms({
      behaviour: {
        Heartbeat: { delayMs: 300 },
        BootNotification: { stallAfter: 1 },
      },
    });
    const ws = new WebSocket(`${csms.wsUrl}CP-SELFTEST`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("mock CSMS refused the socket"));
      });
      const answered = new Map<string, number>();
      const arrival = new Promise<void>((resolve) => {
        ws.onmessage = (event) => {
          const [, id] = JSON.parse(String(event.data)) as [number, string];
          answered.set(id, Date.now());
          if (id === "hb") resolve();
        };
      });
      const sentAt = Date.now();
      ws.send(JSON.stringify([2, "boot-1", "BootNotification", {}]));
      ws.send(JSON.stringify([2, "boot-2", "BootNotification", {}]));
      ws.send(JSON.stringify([2, "hb", "Heartbeat", {}]));
      // The Heartbeat is the sentinel: it was sent after the second boot, so
      // once its (delayed) answer is in, an answer to `boot-2` would already
      // have arrived. No sleep stands in for "nothing came".
      await arrival;
      expect(answered.has("boot-1")).toBe(true);
      expect(answered.has("boot-2")).toBe(false);
      expect(answered.get("hb")! - sentAt).toBeGreaterThanOrEqual(300);
      // Received, though never answered.
      expect(csms.calls("BootNotification")).toBe(2);
    } finally {
      ws.close();
      csms.stop();
    }
  });
});

describe("the slow control-plane relay itself (#523)", () => {
  it("settles an RPC whose daemon socket closed, and lets the client reconnect", async () => {
    // A stand-in daemon that drops the socket on every RPC instead of
    // answering. socket.io-client never calls an ack on a disconnected
    // socket, so without the relay's synthetic ack `drained()` would hang.
    const fake = serveSocketIo();
    fake.io.on("connection", (socket) => {
      socket.on("rpc", () => socket.disconnect(true));
    });
    const relay = startSlowControlPlane({
      daemonUrl: `http://127.0.0.1:${fake.port}`,
    });
    const client = io(relay.url, { path: "/socket.io/" });
    try {
      let connects = 0;
      const reconnected = new Promise<void>((resolve) => {
        client.on("connect", () => {
          if (++connects === 2) resolve();
        });
      });
      await new Promise<void>((resolve) => client.once("connect", resolve));
      const ack = await new Promise<unknown>((resolve) =>
        client.emit("rpc", { method: "cp.list", params: {} }, resolve),
      );
      expect(ack).toEqual({
        ok: false,
        error: { code: RELAY_UPSTREAM_CLOSED },
      });
      await relay.drained();
      // A transport close, which the client reconnects after on its own.
      await reconnected;
      expect(connects).toBe(2);
    } finally {
      client.disconnect();
      relay.stop();
      fake.stop();
    }
  }, 30_000);
});

describe("fleet-bench teardown under a slow CSMS (#330)", () => {
  let daemon: Daemon;
  let outDir: string;

  beforeAll(async () => {
    daemon = await startDaemon();
    outDir = mkdtempSync(join(tmpdir(), "fleet-bench-slowpath-"));
  });

  afterAll(() => {
    daemon?.stop();
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  const activeArgs = (csms: MockCsms, txIntervalSec: number): string[] =>
    benchArgs(csms.wsUrl, daemon.url, outDir, txIntervalSec);

  it("waits out an in-flight cycle's own bound before closing its transaction", async () => {
    // Guards 4 and 5 of #330: teardown settles in-flight cycles first, and
    // for the bound the cycle itself works to — every stage of
    // `cycleBoundMs` — before it re-stops anything.
    //
    // The cycle under test is parked on its assigned-id wait: the CSMS holds
    // StartTransaction.conf for 12s, and SIGINT lands the moment the CSMS
    // receives the StartTransaction. Settling first means the closing stop is
    // sent after the conf, so it carries the real id and the CSMS closes the
    // session. Closing first — or settling for less than the assigned-id
    // stage — sends `stop_transaction` while the id is still the placeholder:
    // the StopTransaction queues behind the unanswered StartTransaction, the
    // charge point is deleted with it still queued, and the CSMS keeps a
    // session nothing can end.
    //
    // The overrides make one stage of the bound decisive: without the
    // assigned-id term it would be 3s (local start) + 1s (hold) + 5s (RPC) =
    // 9s, short of the 12s conf; with it, 104s.
    let bench: RunningBench | null = null;
    const csms = startMockCsms({
      behaviour: { StartTransaction: { delayMs: 12_000 } },
      onCall: sigintOnFirst("StartTransaction", () => bench),
    });
    try {
      bench = startBench(activeArgs(csms, 2), {
        FLEET_BENCH_TEST_RPC_DEADLINE_MS: "5000",
        FLEET_BENCH_TEST_LOCAL_START_TIMEOUT_MS: "3000",
      });
      const run = await bench.done;

      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(SIGINT_EXIT);
      // The discriminating pair, read off the wire first: the session the
      // CSMS opened was closed by a stop carrying its id, and no stop carried
      // anything else.
      expect(csms.openTransactionIds()).toEqual([]);
      expect(csms.unmatchedStops()).toEqual([]);
      // Preconditions, without which the pair above is vacuous: the overrides
      // applied, the cycle really was in flight at teardown, and it was the
      // only one.
      expect(run.stderr).toContain("TEST-ONLY timing overrides in effect");
      expect(csms.calls("StartTransaction")).toBe(1);
      expect(run.stderr).toContain("closing 1 open transaction(s)");
      expect(await listCpIds(daemon.url)).toEqual([]);
    } finally {
      csms.stop();
    }
  }, 240_000);

  it("leaves a retired charge point's transaction for teardown to close", async () => {
    // The retirement branch `fleet-bench.ts` used to call unreachable: a 1.6
    // start whose id did not arrive inside the assigned-id bound is retired
    // *without* a stop, because a stop then would carry the placeholder id
    // and the late conf would find no transaction to assign its id to.
    //
    // A 3s assigned-id bound against a 6s conf retires the charge point; the
    // conf then lands and assigns the real id, and SIGINT sends teardown's
    // closing stop, which must carry it. Stopping at retirement instead
    // leaves id 1 open and records a placeholder stop.
    //
    // SIGINT waits for the StatusNotification(Charging) the charge point
    // emits from its StartTransaction.conf handler, right after storing the
    // id — not for a timer after the reply, which a slow runner can beat
    // before the conf is processed. Only a Charging seen after the reply
    // counts.
    let bench: RunningBench | null = null;
    let confSent = false;
    let interruptedOnCharging = false;
    const csms = startMockCsms({
      behaviour: { StartTransaction: { delayMs: 6_000 } },
      onReply: ({ action, nth }) => {
        if (action === "StartTransaction" && nth === 1) confSent = true;
      },
      onCall: ({ action, payload }) => {
        if (
          action === "StatusNotification" &&
          payload?.status === "Charging" &&
          confSent &&
          !interruptedOnCharging
        ) {
          interruptedOnCharging = true;
          bench?.proc.kill("SIGINT");
        }
      },
    });
    try {
      bench = startBench(activeArgs(csms, 4), {
        FLEET_BENCH_TEST_ASSIGNED_ID_TIMEOUT_MS: "3000",
      });
      const run = await bench.done;

      // First, or a run that never saw Charging ends at --duration with a
      // misleading exit code.
      expect(interruptedOnCharging).toBe(true);
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(SIGINT_EXIT);
      expect(csms.openTransactionIds()).toEqual([]);
      expect(csms.unmatchedStops()).toEqual([]);
      // Preconditions: the branch was taken, and the charge point stopped
      // cycling.
      expect(run.stderr).toContain("Retiring this charge point");
      expect(csms.calls("StartTransaction")).toBe(1);
      expect(await listCpIds(daemon.url)).toEqual([]);
    } finally {
      csms.stop();
    }
  }, 240_000);

  it("re-stops a transaction whose hold teardown cancelled, under a slow StopTransaction", async () => {
    // `stop()` cancels the hold timer that would have sent this cycle's stop,
    // so only teardown's `closeOpenTransactions` can end the session. SIGINT
    // lands 0.5s into a 2s hold, deterministically, where the smoke suite's
    // active-axis case only catches the same mutation when its teardown
    // happens to fall inside a hold.
    //
    // StopTransaction.conf is held for 5s, past the deletion: the closing
    // stop's `stop_transaction` ack says only that the frame was queued, and
    // what this proves is that, with nothing ahead of it in the queue, the
    // frame reached the CSMS before the charge point was deleted — without
    // teardown waiting for its answer. Defaults throughout: no override.
    let bench: RunningBench | null = null;
    let interruptedAtMs: number | null = null;
    let stopReceivedAtMs: number | null = null;
    const csms = startMockCsms({
      behaviour: { StopTransaction: { delayMs: 5_000 } },
      onCall: ({ action }) => {
        if (action === "StopTransaction") stopReceivedAtMs ??= Date.now();
      },
      onReply: ({ action, nth }) => {
        if (action === "StartTransaction" && nth === 1) {
          setTimeout(() => {
            interruptedAtMs = Date.now();
            bench?.proc.kill("SIGINT");
          }, 500);
        }
      },
    });
    try {
      bench = startBench(activeArgs(csms, 4));
      const run = await bench.done;

      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(SIGINT_EXIT);
      expect(csms.openTransactionIds()).toEqual([]);
      expect(csms.unmatchedStops()).toEqual([]);
      // Preconditions: default deadlines, one cycle, and one stop, which
      // reached the CSMS only after the SIGINT — so it was teardown's, not
      // the cycle's own from a hold that expired first on a loaded host.
      // `closing 1 open transaction(s)` alone would not show that: a stop
      // the cycle already sent leaves its charge point on the re-stop list.
      expect(run.stderr).not.toContain("TEST-ONLY timing overrides");
      expect(csms.calls("StartTransaction")).toBe(1);
      expect(csms.calls("StopTransaction")).toBe(1);
      expect(interruptedAtMs).not.toBeNull();
      expect(stopReceivedAtMs).not.toBeNull();
      expect(stopReceivedAtMs!).toBeGreaterThanOrEqual(interruptedAtMs!);
      expect(run.stderr).toContain("closing 1 open transaction(s)");
      expect(await listCpIds(daemon.url)).toEqual([]);
    } finally {
      csms.stop();
    }
  }, 240_000);

  it("keeps a charge point whose stop was acked on the re-stop list", async () => {
    // An acked `stop_transaction` only says the frame was queued, so the
    // cycle moves its charge point from `openTransactions` to
    // `stopsAwaitingWire` rather than dropping it. SIGINT lands when the CSMS
    // receives the cycle's own stop, with its conf held for 5s; teardown
    // settles that cycle first, so by the time it closes transactions the
    // charge point is held on the re-stop list by `stopsAwaitingWire` alone.
    //
    // The re-stop itself sends nothing — the daemon's `stopTransaction`
    // returns once the first stop has closed the connector's transaction —
    // so the CSMS sees one stop either way, and only teardown's own count on
    // stderr tells the two apart. Defaults throughout: no override.
    let bench: RunningBench | null = null;
    const csms = startMockCsms({
      behaviour: { StopTransaction: { delayMs: 5_000 } },
      onCall: sigintOnFirst("StopTransaction", () => bench),
    });
    try {
      bench = startBench(activeArgs(csms, 4));
      const run = await bench.done;

      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(SIGINT_EXIT);
      expect(run.stderr).toContain("closing 1 open transaction(s)");
      // Preconditions: default deadlines, one cycle, and only its own stop
      // on the wire — the re-stop added none.
      expect(run.stderr).not.toContain("TEST-ONLY timing overrides");
      expect(csms.calls("StartTransaction")).toBe(1);
      expect(csms.calls("StopTransaction")).toBe(1);
      expect(csms.openTransactionIds()).toEqual([]);
      expect(csms.unmatchedStops()).toEqual([]);
      expect(await listCpIds(daemon.url)).toEqual([]);
    } finally {
      csms.stop();
    }
  }, 240_000);
});

describe("fleet-bench teardown under a slow control plane (#523, #330)", () => {
  // A daemon of its own: a case here that fails can leave charge points the
  // daemon registered after the bench exited, and the next case's preflight
  // would then refuse the daemon — failing the wrong test.
  let daemon: Daemon;
  let outDir: string;

  beforeAll(async () => {
    daemon = await startDaemon();
    outDir = mkdtempSync(join(tmpdir(), "fleet-bench-slowrpc-"));
  });

  afterAll(() => {
    daemon?.stop();
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  const relayArgs = (
    csms: MockCsms,
    relay: SlowControlPlane,
    txIntervalSec: number,
  ): string[] => benchArgs(csms.wsUrl, relay.url, outDir, txIntervalSec);

  /** The daemon's charge points once every held request has landed, read
   *  from the daemon itself rather than through the relay; then whatever is
   *  left is deleted, so a red case does not leak into the next one. */
  async function daemonCpIdsAfter(relay: SlowControlPlane): Promise<string[]> {
    await relay.drained();
    return withControlPlane(daemon.url, async (rpc) => {
      const ids = await cpIdsVia(rpc);
      for (const cpId of ids) await rpc("cp.delete", { cpId });
      return ids;
    });
  }

  const rpcsOf = (relay: SlowControlPlane, method: string): RelayedRpc[] =>
    relay.rpcs().filter((c) => c.method === method);

  it("reconciles charge points a cp.create_many registered after its client deadline", async () => {
    // #523. The relay holds `cp.create_many` until the daemon has answered
    // teardown's first `cp.delete`, so the charge point is registered after
    // the bench gave up on the call (3s client deadline) and after the first
    // sweep was told `not_found` — by construction, not by racing a timer in
    // this process against one in the bench. SIGINT lands as the create is
    // sent. Only the reconciliation pass, one deadline after that sweep,
    // finds and deletes the charge point. Without `reconcileMissingIds`, it
    // survives the run.
    let bench: RunningBench | null = null;
    let releaseCreate: () => void = () => {};
    const firstDeleteAnswered = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    // Released anyway after 30s, so a run that never deletes still drains.
    const fallback = setTimeout(() => releaseCreate(), 30_000);
    const csms = startMockCsms();
    const relay = startSlowControlPlane({
      daemonUrl: daemon.url,
      holdRequestMs: ({ method }) =>
        method === "cp.create_many" ? firstDeleteAnswered : 0,
      onAnswer: ({ method }) => {
        if (method === "cp.delete") releaseCreate();
      },
      onRpc: sigintOnFirst("cp.create_many", () => bench),
    });
    try {
      bench = startBench(relayArgs(csms, relay, 4), {
        FLEET_BENCH_TEST_RPC_DEADLINE_MS: "3000",
      });
      const run = await bench.done;
      const leftOnDaemon = await daemonCpIdsAfter(relay);

      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(SIGINT_EXIT);
      expect(leftOnDaemon).toEqual([]);
      expect(run.stderr).toContain(
        "reconciliation deleted 1 charge point(s) the daemon created after " +
          "its create RPC had already timed out",
      );
      // Preconditions: the create really did land after the client deadline,
      // and the charge point was first answered `not_found`, then deleted.
      expect(run.stderr).toContain("TEST-ONLY timing overrides in effect");
      const creates = rpcsOf(relay, "cp.create_many");
      expect(creates).toHaveLength(1);
      expect(creates[0]!.ack?.ok).toBe(true);
      expect(
        creates[0]!.answeredAtMs! - creates[0]!.receivedAtMs,
      ).toBeGreaterThan(3_000);
      const deletes = rpcsOf(relay, "cp.delete");
      expect(deletes.map((c) => c.ack?.error?.code ?? "ok")).toEqual([
        "not_found",
        "ok",
      ]);
      expect(creates[0]!.forwardedAtMs!).toBeGreaterThanOrEqual(
        deletes[0]!.answeredAtMs!,
      );
    } finally {
      clearTimeout(fallback);
      relay.stop();
      csms.stop();
    }
  }, 240_000);

  it("waits for an in-flight cp.create_many before the first delete sweep", async () => {
    // The #330 guard the reconciliation above would otherwise hide:
    // the sweep's race rejects on abort and leaves the create running, so
    // teardown awaits the create itself, bounded by its 8s deadline. Here the
    // daemon receives it 2s late and answers well inside that deadline, so a
    // teardown that waits deletes the charge point on its first sweep. One
    // that does not sweeps at once, is answered `not_found`, and only gets
    // the charge point back through a reconciliation pass.
    let bench: RunningBench | null = null;
    const csms = startMockCsms();
    const relay = startSlowControlPlane({
      daemonUrl: daemon.url,
      holdRequestMs: ({ method }) => (method === "cp.create_many" ? 2_000 : 0),
      onRpc: sigintOnFirst("cp.create_many", () => bench),
    });
    try {
      bench = startBench(relayArgs(csms, relay, 4), {
        FLEET_BENCH_TEST_RPC_DEADLINE_MS: "8000",
      });
      const run = await bench.done;
      const leftOnDaemon = await daemonCpIdsAfter(relay);

      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(SIGINT_EXIT);
      expect(
        rpcsOf(relay, "cp.delete").map((c) => c.ack?.error?.code ?? "ok"),
      ).toEqual(["ok"]);
      expect(run.stderr).not.toContain("reconciliation");
      expect(leftOnDaemon).toEqual([]);
      // Preconditions: the create was held, answered, and answered before the
      // delete was sent.
      const creates = rpcsOf(relay, "cp.create_many");
      expect(creates).toHaveLength(1);
      expect(creates[0]!.ack?.ok).toBe(true);
      expect(
        creates[0]!.forwardedAtMs! - creates[0]!.receivedAtMs,
      ).toBeGreaterThanOrEqual(2_000);
    } finally {
      relay.stop();
      csms.stop();
    }
  }, 240_000);

  it("waits out a cycle's slow stop_transaction RPC before deleting its charge point", async () => {
    // #330, the RPC stage of `cycleBoundMs`. The cycle's own
    // `stop_transaction` reaches the daemon 8s late, inside its 12s deadline;
    // SIGINT lands as it is sent. Without the RPC term the cycle's bound is
    // 2s (local start) + 2s (assigned id) + 1s (hold) = 5s, so teardown stops
    // settling, re-stops and deletes the charge point while that stop is
    // still on its way; it then reaches a daemon that no longer has the
    // charge point and is answered `not_found`. With the term, 17s, teardown
    // deletes only once it has been answered.
    //
    // The CSMS sees the same either way — teardown's unconditional re-stop
    // closes the session — so the order the daemon saw the RPCs in is the
    // only observable this term has, and it is what is asserted.
    let bench: RunningBench | null = null;
    const csms = startMockCsms();
    const relay = startSlowControlPlane({
      daemonUrl: daemon.url,
      holdRequestMs: ({ method, nth }) =>
        method === "stop_transaction" && nth === 1 ? 8_000 : 0,
      onRpc: sigintOnFirst("stop_transaction", () => bench),
    });
    try {
      bench = startBench(relayArgs(csms, relay, 2), {
        FLEET_BENCH_TEST_RPC_DEADLINE_MS: "12000",
        FLEET_BENCH_TEST_LOCAL_START_TIMEOUT_MS: "2000",
        FLEET_BENCH_TEST_ASSIGNED_ID_TIMEOUT_MS: "2000",
      });
      const run = await bench.done;
      const leftOnDaemon = await daemonCpIdsAfter(relay);

      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(SIGINT_EXIT);
      const stops = rpcsOf(relay, "stop_transaction");
      const deletes = rpcsOf(relay, "cp.delete");
      expect(deletes).toHaveLength(1);
      // The discriminating pair: the cycle's stop was carried out, and the
      // charge point was deleted only after the daemon had answered it.
      expect(stops[0]!.ack?.ok).toBe(true);
      expect(deletes[0]!.receivedAtMs).toBeGreaterThanOrEqual(
        stops[0]!.answeredAtMs!,
      );
      // Preconditions: one cycle, its stop held, and the session closed.
      expect(stops[0]!.cpId).toBe(deletes[0]!.cpId);
      expect(
        stops[0]!.forwardedAtMs! - stops[0]!.receivedAtMs,
      ).toBeGreaterThanOrEqual(8_000);
      expect(csms.calls("StartTransaction")).toBe(1);
      expect(csms.openTransactionIds()).toEqual([]);
      expect(csms.unmatchedStops()).toEqual([]);
      expect(leftOnDaemon).toEqual([]);
    } finally {
      relay.stop();
      csms.stop();
    }
  }, 240_000);
});
