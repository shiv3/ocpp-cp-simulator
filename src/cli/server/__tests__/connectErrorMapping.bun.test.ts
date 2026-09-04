import { describe, expect, it } from "bun:test";

import { RPC_ERROR_CODES, RpcFailure } from "../../../protocol";
import { OcppSecurityProfileConfigError } from "../../../cp/infrastructure/transport/wsUrlWithBasic";
import { classifyFacadeError } from "../socketServer";

/**
 * #286 — two `connect` failures that reported something else.
 *
 * `not_found` is a statement about the registry, `connect_failed` about the
 * CSMS, `internal` about this daemon. These assert the rule itself
 * ({@link classifyFacadeError}) rather than a copy of it, because the defect
 * being fixed was precisely that one of those words was applied to the wrong
 * situation.
 */
describe("RPC error vocabulary (#286)", () => {
  it("carries connect_failed, distinct from internal", () => {
    expect(RPC_ERROR_CODES).toContain("connect_failed");
    expect(RPC_ERROR_CODES).toContain("internal");
  });

  it("keeps the union closed and free of duplicates", () => {
    expect(new Set(RPC_ERROR_CODES).size).toBe(RPC_ERROR_CODES.length);
  });
});

describe("classifyFacadeError (#286)", () => {
  it("calls a refused upgrade connect_failed, not internal", () => {
    // Verbatim what CLIChargePointService.connect() rejects with when the
    // CSMS answers the upgrade with anything but 101.
    const failure = classifyFacadeError(
      new Error("Connection failed: code=1002 reason=Expected 101 status code"),
    );

    expect(failure?.code).toBe("connect_failed");
    // The close code is the diagnosis, so it has to survive into the message.
    expect(failure?.message).toContain("code=1002");
    expect(failure?.message).toContain("Expected 101 status code");
  });

  it("calls a handshake timeout connect_failed too", () => {
    expect(
      classifyFacadeError(new Error("Connection timeout (30s)"))?.code,
    ).toBe("connect_failed");
  });

  it("still calls an unknown charge point not_found", () => {
    expect(classifyFacadeError(new Error("cpId not found"))?.code).toBe(
      "not_found",
    );
  });

  it("still calls a bad security-profile config invalid_params, naming the field", () => {
    const failure = classifyFacadeError(
      new OcppSecurityProfileConfigError(
        "OCPP security profile 1 requires authorizationKey to derive HTTP Basic Auth.",
      ),
    );

    expect(failure?.code).toBe("invalid_params");
    expect(failure?.message).toContain("authorizationKey");
  });

  it("leaves a genuine fault unclassified, so it stays internal", () => {
    // Nothing about this says "the CSMS refused" or "no such charge point",
    // and guessing would be how a daemon bug gets reported as someone else's.
    expect(
      classifyFacadeError(new Error("Cannot read properties of undefined")),
    ).toBeNull();
    expect(classifyFacadeError("not even an error")).toBeNull();
  });

  it("passes an already-typed failure straight through", () => {
    const original = new RpcFailure("unauthorized", "nope");
    expect(classifyFacadeError(original)).toBe(original);
  });
});
