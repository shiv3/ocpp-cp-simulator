import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@open-ocpp-trace/core";
import { TRACE_SCHEMA_VERSION } from "../traceSchemaVersion";

describe("TRACE_SCHEMA_VERSION", () => {
  it("matches the Open OCPP Trace SDK, which is not loaded at runtime", () => {
    expect(TRACE_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  });
});
