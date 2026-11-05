import { describe, expect, it } from "vitest";
import { AuthorizationCache } from "../AuthorizationCache";
import { LocalAuthListManager } from "../LocalAuthList";
import type { LocalAuthorizationPolicy } from "../LocalAuthorizationResolver";
import { InvalidAuthorizationCacheSeedError } from "../AuthorizationCacheSeed";
import { StationAuthorization } from "../StationAuthorization";
import { Logger } from "../../../shared/Logger";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const LIMITS = { localAuthListMaxLength: 100, sendLocalListMaxLength: 100 };

function build(overrides: Partial<LocalAuthorizationPolicy> = {}) {
  const policy: LocalAuthorizationPolicy = {
    cacheEnabled: true,
    localListEnabled: true,
    localPreAuthorize: false,
    localAuthorizeOffline: true,
    allowOfflineTxForUnknownId: false,
    cacheLifetimeSeconds: null,
    localListChecksExpiry: true,
    ...overrides,
  };
  const cache = new AuthorizationCache("CP", null, { now: () => NOW });
  const localList = new LocalAuthListManager(new Logger());
  const auth = new StationAuthorization({
    cache,
    localList,
    policy: () => policy,
    now: () => NOW,
    idTokenMaxLength: 20,
  });
  return { auth, cache, localList, policy };
}

describe("StationAuthorization.recordCsmsResult", () => {
  it("caches every received status, valid or not (§3.5.1, C10.FR.01)", () => {
    const { auth, cache } = build();
    expect(auth.recordCsmsResult("A", { status: "Accepted" })).toBe(true);
    expect(auth.recordCsmsResult("B", { status: "Blocked" })).toBe(true);
    expect(cache.get("A")?.status).toBe("Accepted");
    expect(cache.get("B")?.status).toBe("Blocked");
  });

  it("keeps the expiry date and the parent id", () => {
    const { auth, cache } = build();
    auth.recordCsmsResult("A", {
      status: "Accepted",
      expiresAt: NOW + 1000,
      parentId: "P",
    });
    expect(cache.get("A")).toMatchObject({
      expiresAt: NOW + 1000,
      parentId: "P",
    });
  });

  it("caches nothing when the cache is disabled", () => {
    const { auth, cache } = build({ cacheEnabled: false });
    expect(auth.recordCsmsResult("A", { status: "Accepted" })).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("never caches an identifier of the local list (§3.5.3, §4.1)", () => {
    const { auth, cache, localList } = build();
    localList.applyFull(
      1,
      [{ idTag: "LISTED", idTagInfo: { status: "Accepted" } }],
      LIMITS,
    );
    expect(auth.recordCsmsResult("LISTED", { status: "Blocked" })).toBe(false);
    expect(cache.get("LISTED")).toBeUndefined();
  });
});

describe("StationAuthorization.decide", () => {
  it("online -> cache -> pre-authorized when LocalPreAuthorize=true (issue test 1)", () => {
    const { auth } = build({ localPreAuthorize: true });
    expect(auth.decide("A", true)).toEqual({
      kind: "askCsms",
      source: "none",
    });
    auth.recordCsmsResult("A", { status: "Accepted" });
    expect(auth.decide("A", true)).toEqual({ kind: "accept", source: "cache" });
  });

  it("reads the local-list expiry date (§3.5.2, §3.5.4)", () => {
    const { auth, localList } = build();
    localList.applyFull(
      1,
      [
        {
          idTag: "OLD",
          idTagInfo: {
            status: "Accepted",
            expiryDate: new Date(NOW - 1).toISOString(),
          },
        },
        {
          idTag: "GOOD",
          idTagInfo: {
            status: "Accepted",
            expiryDate: new Date(NOW + 60_000).toISOString(),
          },
        },
      ],
      LIMITS,
    );
    expect(auth.decide("OLD", false)).toEqual({
      kind: "reject",
      source: "localList",
      status: "Expired",
    });
    expect(auth.decide("GOOD", false)).toEqual({
      kind: "accept",
      source: "localList",
    });
  });

  it("clearCache empties the cache (§5.4, issue test 4)", () => {
    const { auth, cache } = build({ localPreAuthorize: true });
    auth.recordCsmsResult("A", { status: "Accepted" });
    expect(auth.clearCache()).toBe(true);
    expect(cache.size()).toBe(0);
    expect(auth.decide("A", true)).toEqual({
      kind: "askCsms",
      source: "none",
    });
  });
});

/**
 * #452: an idTag / idToken is case insensitive (1.6 Part 2 §7.28 IdToken
 * "CiString20Type ... IdToken is case insensitive"; 2.0.1/2.1 IdTokenType
 * "IdToken is case insensitive"). Both stores fold the lookup key; the
 * spelling last received stays for display and the wire.
 */
describe("StationAuthorization — identifiers are case insensitive", () => {
  type Built = ReturnType<typeof build>;
  const listAs = (b: Built, idTag: string, status: "Accepted" | "Blocked") =>
    b.localList.applyFull(1, [{ idTag, idTagInfo: { status } }], LIMITS);

  it.each<[string, (b: Built) => unknown, unknown]>([
    [
      "a cached tag is found under another case",
      (b) => {
        b.auth.recordCsmsResult("ABC", { status: "Blocked" });
        return b.auth.decide("abc", false);
      },
      { kind: "reject", source: "cache", status: "Blocked" },
    ],
    [
      "a listed tag is found under another case",
      (b) => {
        listAs(b, "ABC", "Blocked");
        return b.auth.decide("abc", false);
      },
      { kind: "reject", source: "localList", status: "Blocked" },
    ],
    [
      "a listed tag is not cached under another case (§3.5.3)",
      (b) => {
        listAs(b, "abc", "Accepted");
        return [
          b.auth.recordCsmsResult("ABC", { status: "Accepted" }),
          b.cache.size(),
        ];
      },
      [false, 0],
    ],
    [
      "a listed Blocked tag beats a cached Accepted one spelt differently",
      (b) => {
        b.auth.recordCsmsResult("ABC", { status: "Accepted" });
        listAs(b, "abc", "Blocked");
        return b.auth.decide("ABC", false);
      },
      { kind: "reject", source: "localList", status: "Blocked" },
    ],
    [
      "a second spelling updates the one cache entry and keeps the new spelling",
      (b) => {
        b.auth.recordCsmsResult("ABC", { status: "Accepted" });
        b.auth.recordCsmsResult("abc", { status: "Invalid" });
        return b.auth.cacheView().entries.map((e) => [e.idToken, e.status]);
      },
      [["abc", "Invalid"]],
    ],
    [
      "a differential update removes a listed tag under another case",
      (b) => {
        listAs(b, "ABC", "Blocked");
        b.localList.applyDifferential(2, [{ idTag: "abc" }], LIMITS);
        return b.localList.size();
      },
      0,
    ],
    [
      "only ASCII letters fold",
      (b) => {
        b.auth.recordCsmsResult("É-1", { status: "Blocked" });
        return b.auth.decide("é-1", false);
      },
      { kind: "reject", source: "unknownOffline", status: "Invalid" },
    ],
  ])("%s", (_label, act, expected) => {
    expect(act(build())).toEqual(expected);
  });

  it("a seed with one identifier in two cases is refused", () => {
    const { auth, cache } = build();
    expect(() =>
      auth.seedCache([
        { idToken: "ABC", status: "Accepted" },
        { idToken: "abc", status: "Blocked" },
      ]),
    ).toThrow(InvalidAuthorizationCacheSeedError);
    expect(cache.size()).toBe(0);
  });
});
