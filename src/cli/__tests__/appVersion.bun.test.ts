import { afterEach, describe, expect, it } from "bun:test";

import { appVersion, DEV_VERSION } from "../appVersion";

/**
 * GHCR release 0.7.5 reported `simulatorVersion: "0.0.0"` in every
 * scenario_report and `serverInfo.version: "0.0.0"` over MCP, because both were
 * hard-coded literals. A report from a release was indistinguishable from one
 * off a dev checkout.
 */
const originalAppVersion = process.env.APP_VERSION;

afterEach(() => {
  if (originalAppVersion === undefined) delete process.env.APP_VERSION;
  else process.env.APP_VERSION = originalAppVersion;
});

describe("appVersion", () => {
  it("prefers an explicit APP_VERSION stamp", () => {
    process.env.APP_VERSION = "1.2.3";
    expect(appVersion()).toBe("1.2.3");
  });

  it("trims the stamp and ignores a blank one", () => {
    process.env.APP_VERSION = "  4.5.6  ";
    expect(appVersion()).toBe("4.5.6");

    process.env.APP_VERSION = "   ";
    // Falls through to package.json, which is the unstamped placeholder in a
    // checkout — so the dev marker, never a bare "0.0.0".
    expect(appVersion()).toBe(DEV_VERSION);
  });

  it("reads the environment on each call, not once at import", () => {
    process.env.APP_VERSION = "7.0.0";
    expect(appVersion()).toBe("7.0.0");
    process.env.APP_VERSION = "8.0.0";
    expect(appVersion()).toBe("8.0.0");
  });

  it("reports the dev marker from an unstamped checkout", () => {
    delete process.env.APP_VERSION;
    // package.json is pinned to the 0.0.0 placeholder in git; the release
    // workflows rewrite it before building. Either way the caller must never
    // see a bare "0.0.0" that looks like a real release.
    expect(appVersion()).toBe(DEV_VERSION);
    expect(appVersion()).not.toBe("0.0.0");
  });
});
