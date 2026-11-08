import { describe, expect, it } from "vitest";

import {
  resolveErrorReportingConfig,
  restrictedDataCollection,
  scrubErrorReport,
} from "../errorReporting";
import { REDACTED_VALUE } from "../redaction";

describe("resolveErrorReportingConfig", () => {
  const DSN = "https://public@o1.ingest.sentry.io/2";

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["not a string", 42],
  ])("stays off when the DSN is %s", (_label, dsn) => {
    expect(
      resolveErrorReportingConfig({
        dsn,
        environment: "prod",
        release: "1.0.0",
      }),
    ).toBeNull();
  });

  it("turns on with a DSN, trimmed, and carries the release", () => {
    expect(
      resolveErrorReportingConfig({
        dsn: `  ${DSN}\n`,
        environment: undefined,
        release: "1.0.0",
      }),
    ).toEqual({ dsn: DSN, release: "1.0.0" });
  });

  it("keeps a non-blank environment and drops a blank one", () => {
    expect(
      resolveErrorReportingConfig({
        dsn: DSN,
        environment: " staging ",
        release: "local-dev",
      }),
    ).toEqual({ dsn: DSN, release: "local-dev", environment: "staging" });
    expect(
      resolveErrorReportingConfig({ dsn: DSN, environment: " ", release: "x" }),
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

describe("scrubErrorReport", () => {
  it("redacts CSMS credentials and OCPP secrets anywhere in the event", () => {
    const event = {
      message: "connect failed to ws://cp01:s3cret@csms.example/ocpp",
      exception: {
        values: [
          {
            type: "Error",
            value:
              'rejected [2,"1","ChangeConfiguration",{"key":"AuthorizationKey","value":"0011AABB"}]',
          },
        ],
      },
      breadcrumbs: [
        { category: "console", message: "Authorization: Bearer tok-123" },
      ],
      extra: { config: { password: "hunter2", cpId: "CP01" } },
    };

    const scrubbed = JSON.stringify(scrubErrorReport(event));

    for (const secret of ["s3cret", "0011AABB", "tok-123", "hunter2"]) {
      expect(scrubbed).not.toContain(secret);
    }
    expect(scrubbed).toContain(REDACTED_VALUE);
    expect(scrubbed).toContain("CP01");
  });

  it("drops cookies and credential headers from the request", () => {
    const scrubbed = scrubErrorReport({
      request: {
        url: "http://daemon/v1/rpc",
        cookies: { session: "abc" },
        headers: {
          Authorization: "Basic Y3A6cGFzcw==",
          "Proxy-Authorization": "Basic eDp5",
          Cookie: "session=abc",
          "User-Agent": "k6",
        },
      },
    });

    expect(scrubbed).toEqual({
      request: {
        url: "http://daemon/v1/rpc",
        headers: { "User-Agent": "k6" },
      },
    });
  });

  it("drops credential headers from header maps anywhere in a breadcrumb or event", () => {
    const breadcrumb = {
      category: "console",
      message: "dial options",
      data: {
        arguments: [
          {
            url: "ws://csms.example/ocpp/CP01",
            headers: {
              authorization: "Basic dXNlcjpwYXNz",
              "PROXY-AUTHORIZATION": "Basic cHJveHk6cHc=",
              "Sec-WebSocket-Protocol": "ocpp1.6",
            },
          },
          [{ "Set-Cookie": ["sid=cookie-1", "csrf=cookie-2"] }],
        ],
      },
    };

    expect(scrubErrorReport(breadcrumb)).toEqual({
      category: "console",
      message: "dial options",
      data: {
        arguments: [
          {
            url: "ws://csms.example/ocpp/CP01",
            headers: { "Sec-WebSocket-Protocol": "ocpp1.6" },
          },
          [{}],
        ],
      },
    });
    expect(
      scrubErrorReport({ extra: { upgrade: { Cookie: "sid=cookie-3" } } }),
    ).toEqual({ extra: { upgrade: {} } });
  });

  it("returns a value Sentry can still send for the event fields it keeps", () => {
    const event = {
      event_id: "abc",
      level: "error",
      release: "1.0.0",
      contexts: { trace: { trace_id: "t" } },
      tags: { mode: "daemon" },
    };
    expect(scrubErrorReport(event)).toEqual(event);
  });
});
