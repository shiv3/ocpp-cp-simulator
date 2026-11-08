import { describe, expect, it } from "vitest";
import {
  assertWsClientOptions,
  UnsupportedWsOptionError,
  unsupportedWsOptions,
  validateWsClientOptions,
} from "../WsClientOptions";

// #611: the support matrix measured with the PoC, and its refusals.

const ALL = {
  handshakeTimeoutMs: 1000,
  perMessageDeflate: false,
  maxPayloadBytes: 4096,
  proxy: "http://proxy.example:3128",
  localAddress: "10.0.0.5",
} as const;

describe("WsClientOptions (#611)", () => {
  it("lists what each runtime cannot honour", () => {
    expect(unsupportedWsOptions(ALL, "bun")).toEqual([
      "maxPayloadBytes",
      "localAddress",
    ]);
    expect(unsupportedWsOptions(ALL, "node")).toEqual(["proxy"]);
    expect(unsupportedWsOptions(ALL, "browser")).toEqual([
      "perMessageDeflate",
      "maxPayloadBytes",
      "proxy",
      "localAddress",
    ]);
  });

  it("an option that is not set is never unsupported", () => {
    expect(unsupportedWsOptions({}, "browser")).toEqual([]);
    expect(unsupportedWsOptions({ perMessageDeflate: true }, "bun")).toEqual(
      [],
    );
  });

  it("refuses, naming the option and the runtime, instead of dropping it", () => {
    expect(() =>
      assertWsClientOptions({ localAddress: "10.0.0.5" }, "bun"),
    ).toThrow(UnsupportedWsOptionError);
    expect(() =>
      assertWsClientOptions({ proxy: "http://p:1" }, "node"),
    ).toThrow(/"proxy" is not supported on node \(supported on: bun\)/);
    expect(assertWsClientOptions({ proxy: "http://p:1" }, "bun")).toEqual({
      proxy: "http://p:1",
    });
    expect(assertWsClientOptions(undefined, "browser")).toEqual({});
  });

  it("checks the shape", () => {
    expect(validateWsClientOptions({ handshakeTimeoutMs: 0 })).toMatch(
      /handshakeTimeoutMs/,
    );
    expect(validateWsClientOptions({ maxPayloadBytes: 1.5 })).toMatch(
      /maxPayloadBytes/,
    );
    expect(validateWsClientOptions({ proxy: "socks5://p:1" })).toMatch(/proxy/);
    expect(validateWsClientOptions({ proxy: "nonsense" })).toMatch(/proxy/);
    expect(validateWsClientOptions({ localAddress: "" })).toMatch(
      /localAddress/,
    );
    expect(validateWsClientOptions(ALL)).toBeUndefined();
    expect(() =>
      assertWsClientOptions({ handshakeTimeoutMs: -1 }, "bun"),
    ).toThrow(RangeError);
  });
});
