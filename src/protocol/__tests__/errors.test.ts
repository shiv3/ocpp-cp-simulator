import { describe, expect, it } from "vitest";

import {
  RPC_ERROR_CODES,
  RpcFailure,
  rpcAckSchema,
  rpcErrorSchema,
  rpcRequestSchema,
} from "../errors";
import {
  ARRAY_1000,
  INFLIGHT_CAP,
  MAX_HTTP_BUFFER,
  ROOM_CAP,
  RPC_RATE_PER_SEC,
  RPC_TIMEOUT_MS,
  SCENARIO_STR_256K,
  STR_64K,
} from "../limits";
import { z } from "zod";

describe("rpc error codes", () => {
  it("is the closed union including timeout and disconnected", () => {
    expect(RPC_ERROR_CODES).toContain("not_found");
    expect(RPC_ERROR_CODES).toContain("invalid_params");
    expect(RPC_ERROR_CODES).toContain("internal");
    expect(RPC_ERROR_CODES).toContain("unauthorized");
    expect(RPC_ERROR_CODES).toContain("timeout");
    expect(RPC_ERROR_CODES).toContain("disconnected");
    expect(RPC_ERROR_CODES).toHaveLength(6);
  });

  it("rpcErrorSchema rejects an unknown code", () => {
    expect(
      rpcErrorSchema.safeParse({ code: "boom", message: "x" }).success,
    ).toBe(false);
    expect(
      rpcErrorSchema.safeParse({ code: "not_found", message: "x" }).success,
    ).toBe(true);
  });

  it("RpcFailure carries a typed code", () => {
    const err = new RpcFailure("not_found", "missing");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("missing");
  });
});

describe("rpc request/ack schemas", () => {
  it("accepts an ok ack", () => {
    expect(rpcAckSchema.safeParse({ ok: true, result: { x: 1 } }).success).toBe(
      true,
    );
  });

  it("accepts an error ack with a known code", () => {
    expect(
      rpcAckSchema.safeParse({
        ok: false,
        error: { code: "invalid_params", message: "bad" },
      }).success,
    ).toBe(true);
  });

  it("rejects an error ack with an unknown code", () => {
    expect(
      rpcAckSchema.safeParse({
        ok: false,
        error: { code: "boom", message: "x" },
      }).success,
    ).toBe(false);
  });

  it("requires method on a request", () => {
    expect(rpcRequestSchema.safeParse({ params: {} }).success).toBe(false);
    expect(
      rpcRequestSchema.safeParse({ method: "status", params: {} }).success,
    ).toBe(true);
  });
});

describe("size-limit helpers", () => {
  it("STR_64K caps strings at 64 KB", () => {
    expect(STR_64K.safeParse("a".repeat(65536)).success).toBe(true);
    expect(STR_64K.safeParse("a".repeat(65537)).success).toBe(false);
  });

  it("SCENARIO_STR_256K caps scenario strings at 256 KB", () => {
    expect(SCENARIO_STR_256K.safeParse("a".repeat(262144)).success).toBe(true);
    expect(SCENARIO_STR_256K.safeParse("a".repeat(262145)).success).toBe(false);
  });

  it("ARRAY_1000 caps arrays at 1000 items", () => {
    const schema = ARRAY_1000(z.number());
    expect(schema.safeParse(new Array(1000).fill(0)).success).toBe(true);
    expect(schema.safeParse(new Array(1001).fill(0)).success).toBe(false);
  });

  it("exposes the numeric DoS/transport constants", () => {
    expect(RPC_TIMEOUT_MS).toBe(30_000);
    expect(MAX_HTTP_BUFFER).toBe(1_000_000);
    expect(ROOM_CAP).toBe(256);
    expect(INFLIGHT_CAP).toBe(64);
    expect(RPC_RATE_PER_SEC).toBe(100);
  });
});
