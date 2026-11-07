// Verification V1 of docs/analyses/charger-engine.md: async functions on a
// VirtualClock are deterministic on Bun. 1,000 simulated chargers run
// behavior-shaped async loops (sleeps, random waits, racing timeouts,
// periodic timers, deep promise chains); the ordered effects of the whole
// fleet are hashed. The same seed gives the same hash, another seed another
// one, and hours of virtual time pass in seconds of real time.
import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { systemRngStreams } from "../rng";
import { HOUR_MS, runFleet } from "./virtualFleet";

const PINNED_HASH =
  "c745d5ba4e9f72906fb5354884de37fbcc4e53d7c8d6a747ebc3919a399307ea";

const hash = (lines: readonly string[]) =>
  createHash("sha256").update(lines.join("\n")).digest("hex");

describe("V1: async behavior on a VirtualClock is deterministic on Bun", () => {
  it("1,000 chargers: the same seed gives the same effect hash, another seed another", async () => {
    const a = await runFleet("seed-A", 1000, 1);
    const b = await runFleet("seed-A", 1000, 1);
    const c = await runFleet("seed-B", 1000, 1);
    expect(a.all.length).toBeGreaterThan(50_000);
    expect(hash(a.all)).toBe(hash(b.all));
    expect(a.all).toEqual(b.all);
    expect(hash(c.all)).not.toBe(hash(a.all));
  }, 120_000);

  it("advances hours of virtual time in seconds of real time", async () => {
    const run = await runFleet("seed-hours", 1000, 6);
    expect(run.virtualMs).toBeGreaterThanOrEqual(6 * HOUR_MS);
    expect(run.timers).toBeGreaterThan(100_000);
    // 6 hours x 1,000 chargers; the budget is generous for a loaded CI host.
    expect(run.realMs).toBeLessThan(60_000);
    console.log(
      `V1: ${run.timers} timers, ${(run.virtualMs / HOUR_MS).toFixed(1)} virtual hours x 1000 chargers in ${(run.realMs / 1000).toFixed(2)} s real`,
    );
  }, 120_000);

  it("adding a charger does not change what another charger does", async () => {
    const without = await runFleet("seed-C", 200, 1);
    const withExtra = await runFleet("seed-C", 200, 1, { extraCharger: true });
    for (const [id, lines] of without.byCharger) {
      expect(hash(withExtra.byCharger.get(id)!)).toBe(hash(lines));
    }
    expect(withExtra.byCharger.has("CP-EXTRA")).toBe(true);
  }, 120_000);

  it("the hash is sensitive: unseeded randomness gives two different runs", async () => {
    const a = await runFleet("x", 50, 1, { streams: systemRngStreams });
    const b = await runFleet("x", 50, 1, { streams: systemRngStreams });
    expect(hash(a.all)).not.toBe(hash(b.all));
  }, 60_000);

  it("is stable across processes: a pinned hash for a small fleet", async () => {
    const run = await runFleet("pinned", 25, 1);
    // If this changes, the RNG, the VirtualClock order or a platform
    // guarantee changed; look before updating it.
    expect(hash(run.all)).toBe(PINNED_HASH);
  }, 60_000);
});
