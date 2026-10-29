import { describe, expect, it } from "vitest";
import { AUTHORIZATION_CACHE_SEED_MAX } from "../../cp/domain/auth/AuthorizationCacheSeed";
import { METHODS } from "../methods";
import { isRpcMethod } from "../index";

/**
 * #452: the control seam over a charge point's Authorization Cache. The
 * seed takes an array, not a record keyed by idToken, so no identifier can
 * land on a prototype key.
 */
describe("authorization cache methods (#452)", () => {
  it("are RPC methods", () => {
    for (const id of [
      "get_auth_cache",
      "seed_auth_cache",
      "clear_auth_cache",
    ]) {
      expect(isRpcMethod(id), id).toBe(true);
    }
  });

  it("get and clear take no params", () => {
    expect(METHODS.get_auth_cache.params.safeParse({}).success).toBe(true);
    expect(METHODS.clear_auth_cache.params.safeParse({}).success).toBe(true);
  });

  const seed = METHODS.seed_auth_cache.params;
  const entry = { idToken: "TAG-1", status: "Accepted" };

  it("seed admits entries with an optional expiry and parent id", () => {
    expect(
      seed.safeParse({
        entries: [
          {
            ...entry,
            expiresAt: "2026-10-30T00:00:00.000Z",
            parentId: "GROUP",
          },
          { idToken: "TAG-2", status: "NotAtThisTime" },
        ],
      }).success,
    ).toBe(true);
  });

  it("seed admits a 255-character idToken (2.1 IdTokenType) and an offset expiry", () => {
    // The per-version bound (20 / 36 / 255) is the charge point's to apply.
    expect(
      seed.safeParse({
        entries: [
          {
            ...entry,
            idToken: "x".repeat(255),
            parentId: "y".repeat(255),
            expiresAt: "2026-10-30T02:00:00+02:00",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("seed admits __proto__ as an ordinary identifier", () => {
    const parsed = seed.safeParse({
      entries: [{ idToken: "__proto__", status: "Blocked" }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.entries[0].idToken).toBe("__proto__");
  });

  it.each([
    ["no entries field", {}],
    ["an empty list", { entries: [] }],
    ["an unknown status", { entries: [{ ...entry, status: "Maybe" }] }],
    ["an empty idToken", { entries: [{ ...entry, idToken: "" }] }],
    [
      "an idToken over 255 chars",
      { entries: [{ ...entry, idToken: "x".repeat(256) }] },
    ],
    [
      "a parentId over 255 chars",
      { entries: [{ ...entry, parentId: "x".repeat(256) }] },
    ],
    ["an empty parentId", { entries: [{ ...entry, parentId: "" }] }],
    ["an unparseable expiry", { entries: [{ ...entry, expiresAt: "soon" }] }],
    // Date.parse reads these as dates on V8; they are not ISO date-times.
    ["a bare year as expiry", { entries: [{ ...entry, expiresAt: "2026" }] }],
    [
      "a word-and-digit expiry",
      { entries: [{ ...entry, expiresAt: "soon 1" }] },
    ],
    ["a bare number as expiry", { entries: [{ ...entry, expiresAt: "0" }] }],
    [
      "an expiry without an offset",
      { entries: [{ ...entry, expiresAt: "2026-10-30T00:00:00" }] },
    ],
    [
      "one idToken in two cases",
      { entries: [entry, { ...entry, idToken: "tag-1" }] },
    ],
    [
      "a duplicate idToken",
      { entries: [entry, { ...entry, status: "Blocked" }] },
    ],
    [
      "more entries than the cache holds",
      {
        entries: Array.from(
          { length: AUTHORIZATION_CACHE_SEED_MAX + 1 },
          (_, i) => ({ idToken: `T${i}`, status: "Accepted" }),
        ),
      },
    ],
  ])("seed refuses %s", (_label, params) => {
    expect(seed.safeParse(params).success).toBe(false);
  });
});
