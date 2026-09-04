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
