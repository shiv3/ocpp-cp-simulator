import { describe, expect, it } from "vitest";
import { ClearCacheHandler } from "../OtherCallHandlers";
import { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../../../domain/types/OcppTypes";
import { Logger } from "../../../../../shared/Logger";
import type { HandlerContext } from "../../MessageHandlerRegistry";

function buildChargePoint(): ChargePoint {
  return new ChargePoint(
    "test-cp-452",
    DefaultBootNotification,
    1,
    "ws://localhost:8080",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
}

function context(chargePoint: HandlerContext["chargePoint"]): HandlerContext {
  return { chargePoint, logger: new Logger() };
}

/**
 * Issue #452, OCPP 1.6 §5.4: ClearCache clears the real Authorization Cache
 * and its status says whether that worked. The simulator implements a cache
 * (the AuthorizationCacheEnabled key exists, §9.1.2), so errata v4.0 §3.23
 * ("not implemented → Rejected") does not apply: clearing a disabled cache
 * succeeds too, and the answer stays Accepted as before #452.
 */
describe("ClearCacheHandler (#452)", () => {
  it("empties the cache and answers Accepted (issue test 4)", () => {
    const cp = buildChargePoint();
    cp.configuration.applyChange("AuthorizationCacheEnabled", "true");
    cp.recordAuthorizationResult("TAG-A", { status: "Accepted" });
    expect(cp.authorization.cache.size()).toBe(1);

    expect(new ClearCacheHandler().handle({}, context(cp))).toEqual({
      status: "Accepted",
    });
    expect(cp.authorization.cache.size()).toBe(0);
  });

  it("answers Accepted with the cache disabled (default), unchanged wire", () => {
    const cp = buildChargePoint();
    expect(new ClearCacheHandler().handle({}, context(cp))).toEqual({
      status: "Accepted",
    });
  });

  it("answers Rejected when the cache could not be cleared", () => {
    const stub = {
      clearAuthorizationCache: () => false,
    } as unknown as HandlerContext["chargePoint"];
    expect(new ClearCacheHandler().handle({}, context(stub))).toEqual({
      status: "Rejected",
    });
  });
});
