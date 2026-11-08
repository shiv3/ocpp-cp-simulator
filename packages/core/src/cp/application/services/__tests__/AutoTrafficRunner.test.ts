import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultAutoTrafficConfig,
  type AutoTrafficConfig,
} from "../../../domain/connector/AutoTraffic";
import { AutoTrafficRunner, type AutoTrafficHooks } from "../AutoTrafficRunner";

const CONFIG: AutoTrafficConfig = {
  ...defaultAutoTrafficConfig,
  enabled: true,
  seed: 3,
  minDurationSec: 10,
  maxDurationSec: 10,
  minGapSec: 5,
  maxGapSec: 5,
  probabilityOfStart: 1,
  requireAuthorize: false,
};

interface Recorder extends AutoTrafficHooks {
  readonly events: string[];
}

function hooks(overrides: Partial<AutoTrafficHooks> = {}): Recorder {
  const events: string[] = [];
  return {
    events,
    authorize: async () => {
      events.push("authorize");
      return true;
    },
    startTransaction: async () => {
      events.push("start");
    },
    stopTransaction: async () => {
      events.push("stop");
    },
    scenarioActive: () => false,
    log: () => {},
    ...overrides,
  } as Recorder;
}

/** Advance fake time and let the runner's awaited hooks settle. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("AutoTrafficRunner (#300)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("leaves a session open while the station has no power and stops it once power returns (#798)", async () => {
    let off = false;
    const h = hooks({ poweredOff: () => off });
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    try {
      await advance(5_000); // the gap, then the start
      expect(h.events).toEqual(["start"]);
      off = true;
      await advance(30_000); // the duration expires during the outage
      expect(h.events).toEqual(["start"]);
      off = false;
      await advance(1_000);
      expect(h.events).toEqual(["start", "stop"]);
    } finally {
      runner.stop();
    }
  });

  it("runs gap, start, duration, stop, repeat", async () => {
    const h = hooks();
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    try {
      await advance(5_000); // the gap
      expect(h.events).toEqual(["start"]);
      await advance(10_000); // the session
      expect(h.events).toEqual(["start", "stop"]);
      await advance(5_000 + 10_000); // the next cycle
      expect(h.events).toEqual(["start", "stop", "start", "stop"]);
      expect(runner.counters.started).toBe(2);
      expect(runner.counters.completed).toBe(2);
    } finally {
      runner.stop();
    }
  });

  it("authorizes first when asked to", async () => {
    const h = hooks();
    const runner = new AutoTrafficRunner(
      { ...CONFIG, requireAuthorize: true },
      "CP1",
      1,
      h,
    );
    runner.start();
    try {
      await advance(5_000);
      expect(h.events).toEqual(["authorize", "start"]);
    } finally {
      runner.stop();
    }
  });

  it("counts a refused Authorize and keeps generating", async () => {
    const h = hooks({ authorize: async () => false });
    const runner = new AutoTrafficRunner(
      { ...CONFIG, requireAuthorize: true },
      "CP1",
      1,
      h,
    );
    runner.start();
    try {
      await advance(5_000);
      expect(h.events).toEqual([]);
      expect(runner.counters.rejected).toBe(1);
      // A refusal is not a reason to stop: surviving it is what a load run is
      // for.
      await advance(5_000);
      expect(runner.counters.attempted).toBe(2);
    } finally {
      runner.stop();
    }
  });

  it("keeps generating after a failed start", async () => {
    const h = hooks({
      startTransaction: async () => {
        throw new Error("CSMS unreachable");
      },
    });
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    try {
      await advance(5_000);
      expect(runner.counters.rejected).toBe(1);
      await advance(5_000);
      expect(runner.counters.attempted).toBe(2);
    } finally {
      runner.stop();
    }
  });

  it("skips an attempt while a scenario owns the connector", async () => {
    // A run's verdict must never depend on whether background traffic fired.
    let scenarioRunning = true;
    const h = hooks({ scenarioActive: () => scenarioRunning });
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    try {
      await advance(5_000);
      expect(h.events).toEqual([]);
      // Skipped, not queued: queuing would burst the moment the scenario
      // ended, which is the interference the rule exists to prevent.
      expect(runner.counters.attempted).toBe(0);

      scenarioRunning = false;
      await advance(5_000);
      expect(h.events).toEqual(["start"]);
    } finally {
      runner.stop();
    }
  });

  it("counts a skipped roll separately from a started session", async () => {
    const h = hooks();
    const runner = new AutoTrafficRunner(
      { ...CONFIG, probabilityOfStart: 0 },
      "CP1",
      1,
      h,
    );
    runner.start();
    try {
      await advance(5_000);
      expect(h.events).toEqual([]);
      expect(runner.counters.skipped).toBe(1);
      expect(runner.counters.started).toBe(0);
    } finally {
      runner.stop();
    }
  });

  it("stops itself once stopAfterSec has elapsed", async () => {
    const h = hooks();
    const runner = new AutoTrafficRunner(
      { ...CONFIG, stopAfterSec: 12 },
      "CP1",
      1,
      h,
    );
    runner.start();
    try {
      await advance(5_000 + 10_000); // one full cycle
      const started = runner.counters.started;
      await advance(60_000);
      expect(runner.counters.started).toBe(started);
    } finally {
      runner.stop();
    }
  });

  it("stops cleanly, leaving no timer behind", async () => {
    const h = hooks();
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    runner.stop();
    await advance(120_000);
    expect(h.events).toEqual([]);
  });

  it("restarts the stream on reconfigure, so a new seed takes effect", async () => {
    const h = hooks();
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    try {
      runner.reconfigure({ ...CONFIG, minGapSec: 1, maxGapSec: 1 });
      await advance(1_000);
      expect(h.events).toEqual(["start"]);
    } finally {
      runner.stop();
    }
  });

  it("does nothing at all when disabled", async () => {
    const h = hooks();
    const runner = new AutoTrafficRunner(
      { ...CONFIG, enabled: false },
      "CP1",
      1,
      h,
    );
    runner.start();
    await advance(120_000);
    expect(h.events).toEqual([]);
  });
});

describe("AutoTrafficRunner idTag, preconditions and counters (#603)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("presents one idTag per session to Authorize and to the start", async () => {
    const tags = ["A", "B"];
    let n = 0;
    const seen: string[] = [];
    const h = hooks({
      idTag: () => tags[n++ % tags.length]!,
      authorize: async (_id, tag) => {
        seen.push(`authorize:${tag}`);
        return true;
      },
      startTransaction: async (_id, tag) => {
        seen.push(`start:${tag}`);
      },
    });
    const runner = new AutoTrafficRunner(
      { ...CONFIG, requireAuthorize: true },
      "CP1",
      1,
      h,
    );
    runner.start();
    try {
      await advance(5_000);
      await advance(10_000 + 5_000);
      expect(seen).toEqual([
        "authorize:A",
        "start:A",
        "authorize:B",
        "start:B",
      ]);
    } finally {
      runner.stop();
    }
  });

  it("falls back to the fixed idTag without a pool hook", async () => {
    const seen: string[] = [];
    const h = hooks({
      startTransaction: async (_id, tag) => {
        seen.push(tag);
      },
    });
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    try {
      await advance(5_000);
      expect(seen).toEqual(["123456"]);
    } finally {
      runner.stop();
    }
  });

  it("skips a cycle whose start precondition fails, and counts the run of skips", async () => {
    let blocker: string | null = "the connector is Charging";
    const h = hooks({ startBlocker: () => blocker });
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    try {
      await advance(5_000);
      await advance(5_000);
      await advance(5_000);
      expect(h.events).toEqual([]);
      expect(runner.counters.attempted).toBe(3);
      expect(runner.counters.skipped).toBe(3);
      expect(runner.counters.consecutiveSkips).toBe(3);

      blocker = null;
      await advance(5_000);
      expect(h.events).toEqual(["start"]);
      expect(runner.counters.consecutiveSkips).toBe(0);
      expect(runner.counters.skipped).toBe(3);
    } finally {
      runner.stop();
    }
  });

  it("counts a roll below probabilityOfStart in the run of skips too", async () => {
    const h = hooks();
    const runner = new AutoTrafficRunner(
      { ...CONFIG, probabilityOfStart: 0 },
      "CP1",
      1,
      h,
    );
    runner.start();
    try {
      await advance(10_000);
      expect(runner.counters.consecutiveSkips).toBe(2);
    } finally {
      runner.stop();
    }
  });

  it("counts Authorize, start and stop outcomes apart", async () => {
    let accept = true;
    const h = hooks({ authorize: async () => accept });
    const runner = new AutoTrafficRunner(
      { ...CONFIG, requireAuthorize: true },
      "CP1",
      1,
      h,
    );
    runner.start();
    try {
      await advance(5_000);
      await advance(10_000);
      expect(runner.counters).toMatchObject({
        authorizeAccepted: 1,
        authorizeRejected: 0,
        startAccepted: 1,
        stopAccepted: 1,
        stopRejected: 0,
      });
      accept = false;
      await advance(5_000);
      expect(runner.counters).toMatchObject({
        authorizeAccepted: 1,
        authorizeRejected: 1,
        startAccepted: 1,
      });
    } finally {
      runner.stop();
    }
  });

  it("counts a start the charge point refused, and a stop that failed", async () => {
    let refuse = true;
    const h = hooks({
      startTransaction: async () => (refuse ? false : undefined),
      stopTransaction: async () => {
        throw new Error("boom");
      },
    });
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    try {
      await advance(5_000);
      expect(runner.counters).toMatchObject({
        startRejected: 1,
        startAccepted: 0,
        started: 0,
        rejected: 1,
      });
      refuse = false;
      await advance(5_000);
      await advance(10_000);
      expect(runner.counters).toMatchObject({
        startAccepted: 1,
        stopRejected: 1,
        stopAccepted: 0,
      });
    } finally {
      runner.stop();
    }
  });

  it("moves a start the CSMS refused in its conf from accepted to rejected", async () => {
    const h = hooks();
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    try {
      await advance(5_000);
      expect(runner.counters.startAccepted).toBe(1);
      runner.noteStartConfRefused();
      expect(runner.counters).toMatchObject({
        startAccepted: 0,
        startRejected: 1,
      });
      // Nothing to correct without an open session.
      await advance(10_000);
      runner.noteStartConfRefused();
      expect(runner.counters.startRejected).toBe(1);
    } finally {
      runner.stop();
    }
  });

  it("counts a refused start answer once per session", async () => {
    const h = hooks();
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    try {
      await advance(5_000);
      runner.noteStartConfRefused();
      runner.noteStartConfRefused();
      expect(runner.counters).toMatchObject({
        startAccepted: 0,
        startRejected: 1,
      });
    } finally {
      runner.stop();
    }
  });

  it("logs a skipped cycle once per reason", async () => {
    const log = vi.fn();
    let blocker = "the connector is Charging";
    const h = hooks({ startBlocker: () => blocker, log });
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    try {
      await advance(5_000);
      await advance(5_000);
      await advance(5_000);
      const skipLogs = () =>
        log.mock.calls.filter(([m]) => String(m).includes("cycle skipped"));
      expect(skipLogs()).toHaveLength(1);
      blocker = "a transaction is active";
      await advance(5_000);
      expect(skipLogs()).toHaveLength(2);
    } finally {
      runner.stop();
    }
  });

  it("records the first and the latest run", async () => {
    const h = hooks();
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    expect(runner.counters.firstRunAt).toBeNull();
    runner.start();
    try {
      await advance(5_000);
      const first = runner.counters.firstRunAt;
      expect(first).not.toBeNull();
      await advance(15_000);
      expect(runner.counters.firstRunAt).toBe(first);
      expect(runner.counters.lastRunAt).toBe(first! + 15_000);
    } finally {
      runner.stop();
    }
  });

  it("stops at the absolute stop time", async () => {
    const stopAt = new Date(Date.now() + 12_000).toISOString();
    const h = hooks();
    const runner = new AutoTrafficRunner({ ...CONFIG, stopAt }, "CP1", 1, h);
    runner.start();
    try {
      await advance(5_000 + 10_000);
      const started = runner.counters.started;
      expect(started).toBe(1);
      await advance(60_000);
      expect(runner.counters.started).toBe(started);
    } finally {
      runner.stop();
    }
  });

  it("is idle after a stop time already in the past", async () => {
    const h = hooks();
    const runner = new AutoTrafficRunner(
      { ...CONFIG, stopAt: new Date(Date.now() - 1000).toISOString() },
      "CP1",
      1,
      h,
    );
    runner.start();
    await advance(60_000);
    expect(h.events).toEqual([]);
    expect(runner.counters.attempted).toBe(0);
  });
});

describe("stopping ends the session it started (#300)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stops an in-flight transaction rather than leaving it charging", async () => {
    // Clearing the duration timer alone left that transaction charging for as
    // long as the daemon lived — disabling traffic, reconfiguring it or
    // deleting the charge point would each have leaked one.
    const h = hooks();
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    await advance(5_000);
    expect(h.events).toEqual(["start"]);

    runner.stop();
    await advance(0);
    expect(h.events).toEqual(["start", "stop"]);
  });

  it("does not stop a session it never started", async () => {
    const h = hooks();
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    runner.stop();
    await advance(0);
    expect(h.events).toEqual([]);
  });

  it("does not schedule a new attempt after being stopped mid-start", async () => {
    // `stop()` can land while the start is in flight; without a post-await
    // check the runner installed a fresh timer after cancellation.
    const pending: { release: (() => void) | null } = { release: null };
    const h = hooks({
      startTransaction: () =>
        new Promise<void>((resolve) => {
          pending.release = resolve;
        }),
    });
    const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
    runner.start();
    await advance(5_000);

    runner.stop();
    pending.release?.();
    await advance(120_000);
    expect(h.events).toEqual(["stop"]);
  });

  describe("sessionModel intent (#327)", () => {
    const INTENT: AutoTrafficConfig = { ...CONFIG, sessionModel: "intent" };

    it("hands the drawn intent to the start and counts a station-side end as completed without a second stop", async () => {
      let running = true;
      const intents: unknown[] = [];
      const h = hooks({
        startTransaction: async (_id, _tag, intent) => {
          intents.push(intent);
          h.events.push("start");
        },
        sessionRunning: () => running,
      });
      const runner = new AutoTrafficRunner(INTENT, "CP1", 1, h);
      runner.start();
      try {
        await advance(5_000); // the gap, then the start
        expect(intents).toHaveLength(1);
        expect(intents[0]).toMatchObject({
          initialSoc: expect.any(Number),
          targetSoc: expect.any(Number),
        });
        running = false; // the connector reached the target and stopped
        await advance(1_000);
        expect(h.events).toEqual(["start"]);
        expect(runner.counters.completed).toBe(1);
      } finally {
        runner.stop();
      }
    });

    it("stops a session whose vehicle never reaches the target at the duration ceiling", async () => {
      const h = hooks({ sessionRunning: () => true });
      const runner = new AutoTrafficRunner(INTENT, "CP1", 1, h);
      runner.start();
      try {
        await advance(5_000);
        await advance(9_000);
        expect(h.events).toEqual(["start"]);
        await advance(1_000); // 10 s ceiling
        expect(h.events).toEqual(["start", "stop"]);
        expect(runner.counters.stopAccepted).toBe(1);
      } finally {
        runner.stop();
      }
    });

    it("passes no intent under the duration model", async () => {
      const seen: unknown[] = [];
      const h = hooks({
        startTransaction: async (_id, _tag, intent) => {
          seen.push(intent);
        },
      });
      const runner = new AutoTrafficRunner(CONFIG, "CP1", 1, h);
      runner.start();
      try {
        await advance(5_000);
        expect(seen).toEqual([undefined]);
      } finally {
        runner.stop();
      }
    });
  });
});
