import { describe, expect, it } from "vitest";
import { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../../domain/types/OcppTypes";
import { Logger } from "../../../../shared/Logger";
import { handleClearCacheV201 } from "../coreControlV201";
import type { V201InboundContext } from "../inboundRegistryV201";

function buildChargePoint(version: string): ChargePoint {
  return new ChargePoint(
    "test-cp-452-v2",
    DefaultBootNotification,
    1,
    "ws://localhost:8080",
    null,
    null,
    null,
    {},
    [],
    version,
    {},
  );
}

function context(chargePoint: ChargePoint): V201InboundContext {
  return { chargePoint, logger: new Logger(), sendCall: () => undefined };
}

/**
 * Issue #452, OCPP 2.0.1 / 2.1 Part 2 C11: ClearCache acts on the real
 * Authorization Cache. Unlike 1.6 (§5.4), C11.FR.04 answers Rejected while
 * AuthCacheCtrlr.Enabled is false, and the content is left alone: the
 * AuthCacheEnabled note says toggling the switch does not alter it, and
 * C11.FR.02 makes the status say whether the cache was cleared.
 */
describe.each(["OCPP-2.0.1", "OCPP-2.1"])("%s ClearCache (C11)", (v) => {
  it("clears the cache and answers Accepted when enabled (C11.FR.03)", () => {
    const cp = buildChargePoint(v);
    cp.configuration.applyChange("AuthorizationCacheEnabled", "true");
    cp.recordAuthorizationResult("TAG-A", { status: "Accepted" });
    expect(cp.authorization.cache.size()).toBe(1);

    expect(handleClearCacheV201({}, context(cp)).response).toEqual({
      status: "Accepted",
    });
    expect(cp.authorization.cache.size()).toBe(0);
  });

  it("answers Rejected and keeps the content when disabled (C11.FR.04)", () => {
    const cp = buildChargePoint(v);
    cp.configuration.applyChange("AuthorizationCacheEnabled", "true");
    cp.recordAuthorizationResult("TAG-A", { status: "Accepted" });
    cp.configuration.applyChange("AuthorizationCacheEnabled", "false");

    expect(handleClearCacheV201({}, context(cp)).response).toEqual({
      status: "Rejected",
    });
    expect(cp.authorization.cache.size()).toBe(1);
  });

  it("answers Rejected under the default configuration (cache disabled)", () => {
    const cp = buildChargePoint(v);
    expect(handleClearCacheV201({}, context(cp)).response).toEqual({
      status: "Rejected",
    });
  });

  it("answers Rejected when clearing failed (C11.FR.05)", () => {
    const cp = buildChargePoint(v);
    cp.configuration.applyChange("AuthorizationCacheEnabled", "true");
    cp.clearAuthorizationCache = () => false;
    expect(handleClearCacheV201({}, context(cp)).response).toEqual({
      status: "Rejected",
    });
  });
});
