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
// WHAT IS NOT COVERED HERE, AND WHY. A mock CSMS can slow the CSMS-side stages
// of a cycle (Authorize, StartTransaction, StopTransaction) but not the
// control-plane RPCs: the daemon acks `start_transaction` before Authorize is
// answered and `stop_transaction` once the frame is queued, so no RPC stage of
// `cycleBoundMs` can be made slow from here. Dropping the RPC terms from that
// bound therefore still passes this file. Nor can it make `cp.create_many`
// outlive its client deadline: the daemon's create handler does not wait for
// the charge point to connect. See the README's "Known limitations".
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listCpIds,
  startBench,
  startDaemon,
  startMockCsms,
  type Daemon,
  type MockCsms,
  type RunningBench,
} from "./smokeHarness.ts";

/** Exit code of the bench's SIGINT path: `cleanup()` ran, then `exit(130)`. */
const SIGINT_EXIT = 130;

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

  /** One charge point on the active axis, against `csms`, with no
   *  measurement window short enough to end the run before the SIGINT the
   *  case sends. A 30s heartbeat keeps Heartbeats out of the 1.6 serial queue
   *  while a conf is held back, so nothing but the cycle under test is queued
   *  behind it. */
  function activeArgs(csms: MockCsms, txIntervalSec: number): string[] {
    return [
      "--csms-url",
      csms.wsUrl,
      "--daemon-url",
      daemon.url,
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

  /** SIGINT the bench, once, `afterMs` from now. */
  function interruptLater(bench: () => RunningBench | null, afterMs: number) {
    setTimeout(() => bench()?.proc.kill("SIGINT"), afterMs);
  }

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
      onCall: ({ action, nth }) => {
        if (action === "StartTransaction" && nth === 1) {
          bench?.proc.kill("SIGINT");
        }
      },
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
    // conf then lands and assigns the real id, and SIGINT 1.5s later sends
    // teardown's closing stop, which must carry it. Stopping at retirement
    // instead leaves id 1 open and records a placeholder stop.
    let bench: RunningBench | null = null;
    const csms = startMockCsms({
      behaviour: { StartTransaction: { delayMs: 6_000 } },
      onReply: ({ action, nth }) => {
        if (action === "StartTransaction" && nth === 1) {
          interruptLater(() => bench, 1_500);
        }
      },
    });
    try {
      bench = startBench(activeArgs(csms, 4), {
        FLEET_BENCH_TEST_ASSIGNED_ID_TIMEOUT_MS: "3000",
      });
      const run = await bench.done;

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
});
