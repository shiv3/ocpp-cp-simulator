import { describe, expect, it } from "vitest";

import {
  resolveErrorReporterName,
  SCRUB_MAX_OBJECTS,
  scrubErrorReport,
} from "../errorReporting";
import { REDACTED_VALUE } from "../redaction";

describe("resolveErrorReporterName", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", " \t"],
    ["not a string", 1],
  ])("is null (reporting off) when the selector is %s", (_label, value) => {
    expect(resolveErrorReporterName(value)).toBeNull();
  });

  it("trims a built-in name or a module specifier", () => {
    expect(resolveErrorReporterName(" sentry\n")).toBe("sentry");
    expect(resolveErrorReporterName("./reporters/datadog.ts")).toBe(
      "./reporters/datadog.ts",
    );
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

  it("scrubs a breadcrumb whose console arguments are cyclic", () => {
    // Sentry hands beforeBreadcrumb the raw console arguments (events are
    // normalized first, breadcrumbs are not): a throw drops the breadcrumb.
    const station: Record<string, unknown> = {
      id: "CP01",
      password: "secret-1",
      headers: { Authorization: "Basic abc" },
    };
    station.self = station;
    const scrubbed = scrubErrorReport({
      category: "console",
      data: { arguments: [station, [station]] },
    });
    expect(scrubbed).toEqual({
      category: "console",
      data: {
        arguments: [
          { id: "CP01", headers: {}, self: "[Circular]" },
          [{ id: "CP01", headers: {}, self: "[Circular]" }],
        ],
      },
    });
  });

  it("scrubs every copy of an object shared by sibling members", () => {
    const shared = { url: "ws://cp:pw@csms.example/ocpp", password: "pw" };
    expect(
      scrubErrorReport({ data: { first: shared, second: [shared] } }),
    ).toEqual({
      data: {
        first: { url: `ws://cp:${REDACTED_VALUE}@csms.example/ocpp` },
        second: [{ url: `ws://cp:${REDACTED_VALUE}@csms.example/ocpp` }],
      },
    });
  });

  it("bounds the copy of objects shared along many paths", () => {
    // Each level references the one below twice: 2^18 paths to the bottom,
    // which an unbounded copy would walk synchronously.
    let level: Record<string, unknown> = { password: "pw" };
    for (let i = 0; i < 18; i++) level = { left: level, right: level };

    const scrubbed = JSON.stringify(scrubErrorReport({ data: level }));

    expect(scrubbed).toContain('"[Truncated]"');
    expect(scrubbed).not.toContain('"pw"');
    expect(scrubbed.split("{").length - 1).toBeLessThanOrEqual(
      SCRUB_MAX_OBJECTS,
    );
  });

  it("copies up to SCRUB_MAX_OBJECTS objects and truncates past them", () => {
    // The report, its `items` array and the items are all objects.
    const report = (items: number) => ({
      items: Array.from({ length: items }, (_, id) => ({ id })),
    });
    const fits = report(SCRUB_MAX_OBJECTS - 2);
    expect(scrubErrorReport(fits)).toEqual(fits);

    const over = scrubErrorReport(report(SCRUB_MAX_OBJECTS - 1));
    expect(over.items.at(-2)).toEqual({ id: SCRUB_MAX_OBJECTS - 3 });
    expect(over.items.at(-1)).toBe("[Truncated]");
  });

  // Sentry normalizes `extra` / `contexts` to `normalizeDepth` before
  // `beforeSend`: an object past that depth becomes "[Object]", a primitive
  // beside it stays, so the variable's name is gone but its value is not.
  it.each([
    ["normalized away by depth", "[Object]"],
    ["normalized away as a cycle", "[Circular ~]"],
    ["cut by the scrubber's own cycle break", "[Circular]"],
    ["missing its name", {}],
  ])(
    "redacts attributeValue when the variable beside it is %s",
    (_, variable) => {
      expect(
        scrubErrorReport({
          extra: {
            payload: {
              setVariableData: [
                { component: "[Object]", variable, attributeValue: "s3cret" },
              ],
            },
          },
        }),
      ).toEqual({
        extra: {
          payload: {
            setVariableData: [
              {
                component: "[Object]",
                variable,
                attributeValue: REDACTED_VALUE,
              },
            ],
          },
        },
      });
    },
  );

  it("keeps the attributeValue of a variable whose name is not a secret", () => {
    const entry = {
      component: { name: "OCPPCommCtrlr" },
      variable: { name: "HeartbeatInterval" },
      attributeValue: "60",
    };
    expect(scrubErrorReport({ extra: { entry } })).toEqual({
      extra: { entry },
    });
  });
});
