import { describe, expect, it } from "vitest";
import { isMissingTraceSdk, loadTraceFeature } from "../loadTraceFeature";

describe("loadTraceFeature", () => {
  it("returns the module when it loads", async () => {
    await expect(loadTraceFeature("x", async () => 42)).resolves.toBe(42);
  });

  it("explains a missing SDK", async () => {
    const missing = Object.assign(
      new Error("Cannot find module '@open-ocpp-trace/jsonl/writer'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    await expect(
      loadTraceFeature("--trace-output", async () => {
        throw missing;
      }),
    ).rejects.toThrow(
      /--trace-output needs the Open OCPP Trace SDK.*read:packages/,
    );
  });

  it("rethrows any other failure untouched", async () => {
    const boom = new Error("boom");
    await expect(
      loadTraceFeature("x", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(isMissingTraceSdk(new Error("Cannot find module './other'"))).toBe(
      false,
    );
  });
});
