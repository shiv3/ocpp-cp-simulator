import { describe, expect, it } from "vitest";

import {
  resolveSentryConfig,
  restrictedDataCollection,
} from "../sentryOptions";

describe("resolveSentryConfig", () => {
  const DSN = "https://public@o1.ingest.sentry.io/2";

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["not a string", 42],
  ])("stays off when the DSN is %s", (_label, dsn) => {
    expect(
      resolveSentryConfig({
        dsn,
        environment: "prod",
        release: "1.0.0",
      }),
    ).toBeNull();
  });

  it("turns on with a DSN, trimmed, and carries the release", () => {
    expect(
      resolveSentryConfig({
        dsn: `  ${DSN}\n`,
        environment: undefined,
        release: "1.0.0",
      }),
    ).toEqual({ dsn: DSN, release: "1.0.0" });
  });

  it("keeps a non-blank environment and drops a blank one", () => {
    expect(
      resolveSentryConfig({
        dsn: DSN,
        environment: " staging ",
        release: "local-dev",
      }),
    ).toEqual({ dsn: DSN, release: "local-dev", environment: "staging" });
    expect(
      resolveSentryConfig({ dsn: DSN, environment: " ", release: "x" }),
    ).toEqual({ dsn: DSN, release: "x" });
  });
});

describe("restrictedDataCollection", () => {
  it("turns off every optional category the SDK would collect", () => {
    const leaves = (value: unknown): unknown[] =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.values(value).flatMap(leaves)
        : [value];

    const collection = restrictedDataCollection();

    expect(collection.httpBodies).toEqual([]);
    expect(
      leaves({ ...collection, httpBodies: undefined }).filter(
        (leaf) => leaf !== undefined,
      ),
    ).toSatisfy((values: unknown[]) => values.every((v) => v === false));
    // The SDK's defaults are `true` for these: name them so a rename fails here.
    expect(collection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      urlQueryParams: false,
      stackFrameVariables: false,
    });
  });
});
