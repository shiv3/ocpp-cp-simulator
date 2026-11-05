import { describe, expect, it } from "vitest";

import { EXPLICIT_METHODS, METHODS } from "../methods";

describe("network simulation methods (Task 16)", () => {
  describe("network_sim.global.get", () => {
    it("accepts empty params", () => {
      expect(
        METHODS["network_sim.global.get"].params.safeParse({}).success,
      ).toBe(true);
    });

    it("has ANY result type", () => {
      expect(
        METHODS["network_sim.global.get"].result.safeParse(null).success,
      ).toBe(true);
      expect(
        METHODS["network_sim.global.get"].result.safeParse({ any: "value" })
          .success,
      ).toBe(true);
    });
  });

  describe("network_sim.global.save", () => {
    it("accepts a bounded config object", () => {
      const parsed = METHODS["network_sim.global.save"].params.safeParse({
        config: { setting1: "value1", setting2: 42 },
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts null config (delete semantics)", () => {
      const parsed = METHODS["network_sim.global.save"].params.safeParse({
        config: null,
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects oversized config object", () => {
      const largeObj: Record<string, unknown> = {};
      for (let i = 0; i < 1000; i++) {
        largeObj[`key${i}`] = "a".repeat(100);
      }
      const parsed = METHODS["network_sim.global.save"].params.safeParse({
        config: largeObj,
      });
      expect(parsed.success).toBe(false);
    });

    it("requires config field", () => {
      const parsed = METHODS["network_sim.global.save"].params.safeParse({});
      expect(parsed.success).toBe(false);
    });
  });

  describe("network_sim.cp.get", () => {
    it("accepts cpId in params", () => {
      const parsed = METHODS["network_sim.cp.get"].params.safeParse({
        cpId: "cp-001",
      });
      expect(parsed.success).toBe(true);
    });

    it("requires cpId", () => {
      const parsed = METHODS["network_sim.cp.get"].params.safeParse({});
      expect(parsed.success).toBe(false);
    });

    it("rejects oversized cpId", () => {
      const parsed = METHODS["network_sim.cp.get"].params.safeParse({
        cpId: "a".repeat(70_000),
      });
      expect(parsed.success).toBe(false);
    });

    it("has ANY result type", () => {
      expect(
        METHODS["network_sim.cp.get"].result.safeParse({ any: "data" }).success,
      ).toBe(true);
    });
  });

  describe("network_sim.cp.save", () => {
    it("accepts cpId and bounded config", () => {
      const parsed = METHODS["network_sim.cp.save"].params.safeParse({
        cpId: "cp-001",
        config: { setting: "value" },
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts null config (delete semantics)", () => {
      const parsed = METHODS["network_sim.cp.save"].params.safeParse({
        cpId: "cp-001",
        config: null,
      });
      expect(parsed.success).toBe(true);
    });

    it("requires cpId", () => {
      const parsed = METHODS["network_sim.cp.save"].params.safeParse({
        config: { setting: "value" },
      });
      expect(parsed.success).toBe(false);
    });

    it("requires config field", () => {
      const parsed = METHODS["network_sim.cp.save"].params.safeParse({
        cpId: "cp-001",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects oversized config object", () => {
      const largeObj: Record<string, unknown> = {};
      for (let i = 0; i < 1000; i++) {
        largeObj[`key${i}`] = "a".repeat(100);
      }
      const parsed = METHODS["network_sim.cp.save"].params.safeParse({
        cpId: "cp-001",
        config: largeObj,
      });
      expect(parsed.success).toBe(false);
    });

    it("has ANY result type", () => {
      expect(
        METHODS["network_sim.cp.save"].result.safeParse({ ok: true }).success,
      ).toBe(true);
    });
  });

  describe("network_sim.disconnect.trigger", () => {
    it("accepts cpId and ruleId", () => {
      const parsed = METHODS["network_sim.disconnect.trigger"].params.safeParse(
        {
          cpId: "cp-001",
          ruleId: "rule-42",
        },
      );
      expect(parsed.success).toBe(true);
    });

    it("requires cpId", () => {
      const parsed = METHODS["network_sim.disconnect.trigger"].params.safeParse(
        {
          ruleId: "rule-42",
        },
      );
      expect(parsed.success).toBe(false);
    });

    it("requires ruleId", () => {
      const parsed = METHODS["network_sim.disconnect.trigger"].params.safeParse(
        {
          cpId: "cp-001",
        },
      );
      expect(parsed.success).toBe(false);
    });

    it("rejects oversized cpId", () => {
      const parsed = METHODS["network_sim.disconnect.trigger"].params.safeParse(
        {
          cpId: "a".repeat(70_000),
          ruleId: "rule-42",
        },
      );
      expect(parsed.success).toBe(false);
    });

    it("rejects oversized ruleId", () => {
      const parsed = METHODS["network_sim.disconnect.trigger"].params.safeParse(
        {
          cpId: "cp-001",
          ruleId: "a".repeat(70_000),
        },
      );
      expect(parsed.success).toBe(false);
    });

    it("has ANY result type", () => {
      expect(
        METHODS["network_sim.disconnect.trigger"].result.safeParse({}).success,
      ).toBe(true);
    });
  });

  describe("reset method", () => {
    it("is a flat lifecycle method with EMPTY params", () => {
      const parsed = METHODS.reset.params.safeParse({});
      expect(parsed.success).toBe(true);
    });

    it("has ANY result type", () => {
      expect(METHODS.reset.result.safeParse({ ok: true }).success).toBe(true);
    });

    it("is NOT in EXPLICIT_METHODS (flows through cp facade)", () => {
      expect(EXPLICIT_METHODS).not.toContain("reset");
    });
  });

  describe("EXPLICIT_METHODS registration", () => {
    it("includes all five network_sim methods", () => {
      expect(EXPLICIT_METHODS).toContain("network_sim.global.get");
      expect(EXPLICIT_METHODS).toContain("network_sim.global.save");
      expect(EXPLICIT_METHODS).toContain("network_sim.cp.get");
      expect(EXPLICIT_METHODS).toContain("network_sim.cp.save");
      expect(EXPLICIT_METHODS).toContain("network_sim.disconnect.trigger");
    });

    it("does not include reset (flat method, not explicit)", () => {
      expect(EXPLICIT_METHODS).not.toContain("reset");
    });
  });

  describe("Zod schema round-trip validation", () => {
    it("network_sim.global.save round-trips config objects", () => {
      const input = { config: { layer: "default", enabled: true } };
      const parsed = METHODS["network_sim.global.save"].params.safeParse(input);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data).toEqual(input);
    });

    it("network_sim.cp.save round-trips config objects with cpId", () => {
      const input = {
        cpId: "cp-test",
        config: { latency: 100, jitter: 10 },
      };
      const parsed = METHODS["network_sim.cp.save"].params.safeParse(input);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data).toEqual(input);
    });

    it("network_sim.disconnect.trigger round-trips rule parameters", () => {
      const input = { cpId: "cp-001", ruleId: "disconnect-delay-5s" };
      const parsed =
        METHODS["network_sim.disconnect.trigger"].params.safeParse(input);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data).toEqual(input);
    });
  });
});
