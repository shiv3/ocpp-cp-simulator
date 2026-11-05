import type { ChargePointInitOptions } from "../types";

/**
 * A charge point config for tests that build a CLIChargePointService, so a
 * new required field is added here rather than in every test. The default
 * `wsUrl` points at a port nothing listens on: the charge point never
 * connects unless a test passes a CSMS URL.
 */
export function testCpInit(
  overrides: Partial<ChargePointInitOptions> &
    Pick<ChargePointInitOptions, "cpId">,
): ChargePointInitOptions {
  return {
    wsUrl: "ws://127.0.0.1:65534/never",
    connectors: 1,
    vendor: "v",
    model: "m",
    basicAuth: null,
    ...overrides,
  };
}
