import { describe, expect, it } from "vitest";

import { strictValidationErrors, validationErrors } from "../validate";

/**
 * #285 — the formats the refusal gate depends on.
 *
 * `validationErrors` leaves formats unchecked on purpose: a CSMS with a
 * sloppy timestamp is still worth simulating against. `strictValidationErrors`
 * is the pair used where a request is *refused*, so what it accepts is a
 * contract, and each case below is one an OCPP payload can actually carry.
 */
const schema = {
  $schema: "http://json-schema.org/draft-04/schema#",
  type: "object",
  properties: {
    d: { type: "string", format: "date-time" },
    u: { type: "string", format: "uri" },
  },
};

const accepts = (value: Record<string, string>): boolean =>
  strictValidationErrors(schema, value).length === 0;

describe("strictValidationErrors date-time", () => {
  it.each([
    ["a plain instant", "2026-01-01T00:00:00Z"],
    ["fractional seconds", "2026-01-01T00:00:00.123Z"],
    ["an offset", "2026-01-01T00:00:00+09:00"],
    ["a leap day", "2024-02-29T00:00:00Z"],
    // RFC 3339 allows it and Date.parse does not, which is one reason this
    // check does not defer to Date.parse.
    ["a leap second", "2016-12-31T23:59:60Z"],
  ])("accepts %s", (_label, d) => {
    expect(accepts({ d })).toBe(true);
  });

  it.each([
    // Date.parse would NORMALISE this to March 2 and report success — the
    // other reason.
    ["a day that does not exist", "2026-02-30T00:00:00Z"],
    ["Feb 29 in a common year", "2026-02-29T00:00:00Z"],
    ["hour 24", "2026-01-01T24:00:00Z"],
    ["month 13", "2026-13-01T00:00:00Z"],
    ["no offset at all", "2026-01-01T00:00:00"],
    ["prose", "not-a-date"],
  ])("refuses %s", (_label, d) => {
    expect(accepts({ d })).toBe(false);
  });
});

describe("strictValidationErrors uri", () => {
  it.each([
    ["an ftp location", "ftp://host/dir/file.zip"],
    ["an https location", "https://host/a/b"],
    ["a percent-encoded space", "https://host/a%20b"],
  ])("accepts %s", (_label, u) => {
    expect(accepts({ u })).toBe(true);
  });

  it.each([
    // `new URL()` accepts the first two by normalising them, which is why the
    // RFC 3986 character rules are checked before it.
    ["a raw space", "ftp://host/a b"],
    ["a dangling percent", "ftp://host/%"],
    ["a bare word", "not a uri"],
    ["a relative path", "/dir/file.zip"],
  ])("refuses %s", (_label, u) => {
    expect(accepts({ u })).toBe(false);
  });
});

describe("the lenient pair is unchanged", () => {
  it("still ignores formats, so the warning path stays permissive", () => {
    expect(
      validationErrors(schema, { d: "not-a-date", u: "not a uri" }),
    ).toEqual([]);
  });
});
