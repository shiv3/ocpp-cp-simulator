import { describe, expect, it } from "vitest";
import {
  resolveLocalAuthorization,
  type LocalAuthorizationPolicy,
} from "../LocalAuthorizationResolver";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const PAST = NOW - 1000;
const FUTURE = NOW + 60_000;

/** The OCPP 1.6 defaults of this simulator (Configuration.ts). */
const DEFAULTS: LocalAuthorizationPolicy = {
  cacheEnabled: false,
  localListEnabled: true,
  localPreAuthorize: false,
  localAuthorizeOffline: true,
  allowOfflineTxForUnknownId: false,
  cacheLifetimeSeconds: null,
  localListChecksExpiry: true,
};

function policy(
  overrides: Partial<LocalAuthorizationPolicy> = {},
): LocalAuthorizationPolicy {
  return { ...DEFAULTS, ...overrides };
}

const cached = (status: string, extra: { expiresAt?: number } = {}) => ({
  status,
  updatedAt: NOW - 10_000,
  ...extra,
});

describe("resolveLocalAuthorization — online", () => {
  it("asks the CSMS for an unknown identifier (1.6 §4.1)", () => {
    expect(
      resolveLocalAuthorization({ online: true, policy: policy(), now: NOW }),
    ).toEqual({ kind: "askCsms", source: "none" });
  });

  it("asks the CSMS for a cached Accepted identifier when LocalPreAuthorize=false", () => {
    expect(
      resolveLocalAuthorization({
        online: true,
        policy: policy({ cacheEnabled: true }),
        cacheEntry: cached("Accepted"),
        now: NOW,
      }),
    ).toEqual({ kind: "askCsms", source: "cache" });
  });

  it("pre-authorizes a cached Accepted identifier when LocalPreAuthorize=true (§9.1.13, C12.FR.02)", () => {
    expect(
      resolveLocalAuthorization({
        online: true,
        policy: policy({ cacheEnabled: true, localPreAuthorize: true }),
        cacheEntry: cached("Accepted"),
        now: NOW,
      }),
    ).toEqual({ kind: "accept", source: "cache" });
  });

  it("pre-authorizes a local-list Accepted identifier when LocalPreAuthorize=true (C14.FR.02)", () => {
    expect(
      resolveLocalAuthorization({
        online: true,
        policy: policy({ localPreAuthorize: true }),
        localListEntry: { status: "Accepted" },
        now: NOW,
      }),
    ).toEqual({ kind: "accept", source: "localList" });
  });

  it("ignores the cache when AuthorizationCacheEnabled=false", () => {
    expect(
      resolveLocalAuthorization({
        online: true,
        policy: policy({ localPreAuthorize: true }),
        cacheEntry: cached("Accepted"),
        now: NOW,
      }),
    ).toEqual({ kind: "askCsms", source: "none" });
  });

  it("ignores the local list when LocalAuthListEnabled=false", () => {
    expect(
      resolveLocalAuthorization({
        online: true,
        policy: policy({ localPreAuthorize: true, localListEnabled: false }),
        localListEntry: { status: "Accepted" },
        now: NOW,
      }),
    ).toEqual({ kind: "askCsms", source: "none" });
  });

  it.each(["Invalid", "Blocked", "Expired", "ConcurrentTx"])(
    "asks the CSMS, never denies locally, for a cached %s identifier (§3.5.1, C10.FR.03)",
    (status) => {
      expect(
        resolveLocalAuthorization({
          online: true,
          policy: policy({ cacheEnabled: true, localPreAuthorize: true }),
          cacheEntry: cached(status),
          now: NOW,
        }),
      ).toEqual({ kind: "askCsms", source: "cache" });
    },
  );

  it("asks the CSMS for a local-list entry other than Accepted (C14.FR.03)", () => {
    expect(
      resolveLocalAuthorization({
        online: true,
        policy: policy({ localPreAuthorize: true }),
        localListEntry: { status: "Blocked" },
        now: NOW,
      }),
    ).toEqual({ kind: "askCsms", source: "localList" });
  });

  it("asks the CSMS for a cached Accepted entry whose expiryDate has passed", () => {
    expect(
      resolveLocalAuthorization({
        online: true,
        policy: policy({ cacheEnabled: true, localPreAuthorize: true }),
        cacheEntry: cached("Accepted", { expiresAt: PAST }),
        now: NOW,
      }),
    ).toEqual({ kind: "askCsms", source: "cache" });
  });

  it("asks the CSMS for a local-list Accepted entry whose expiry has passed (C14.FR.05)", () => {
    expect(
      resolveLocalAuthorization({
        online: true,
        policy: policy({ localPreAuthorize: true }),
        localListEntry: { status: "Accepted", expiresAt: PAST },
        now: NOW,
      }),
    ).toEqual({ kind: "askCsms", source: "localList" });
  });

  it("local list wins over the cache for the same identifier (§3.5.3, C14.FR.01)", () => {
    // Cached Accepted, listed Blocked: the list decides, so no pre-authorization.
    expect(
      resolveLocalAuthorization({
        online: true,
        policy: policy({ cacheEnabled: true, localPreAuthorize: true }),
        localListEntry: { status: "Blocked" },
        cacheEntry: cached("Accepted"),
        now: NOW,
      }),
    ).toEqual({ kind: "askCsms", source: "localList" });
  });
});

describe("resolveLocalAuthorization — offline", () => {
  it("refuses an unknown identifier by default (AllowOfflineTxForUnknownId=false, C15 step 5)", () => {
    expect(
      resolveLocalAuthorization({ online: false, policy: policy(), now: NOW }),
    ).toEqual({ kind: "reject", source: "unknownOffline", status: "Invalid" });
  });

  it("accepts an unknown identifier when AllowOfflineTxForUnknownId=true (§3.5.4, C15.FR.08)", () => {
    expect(
      resolveLocalAuthorization({
        online: false,
        policy: policy({ allowOfflineTxForUnknownId: true }),
        now: NOW,
      }),
    ).toEqual({ kind: "accept", source: "unknownOffline" });
  });

  it("accepts a cached Accepted identifier when LocalAuthorizeOffline=true (§9.1.12)", () => {
    expect(
      resolveLocalAuthorization({
        online: false,
        policy: policy({ cacheEnabled: true }),
        cacheEntry: cached("Accepted", { expiresAt: FUTURE }),
        now: NOW,
      }),
    ).toEqual({ kind: "accept", source: "cache" });
  });

  it("accepts a local-list Accepted identifier when LocalAuthorizeOffline=true (C13.FR.02)", () => {
    expect(
      resolveLocalAuthorization({
        online: false,
        policy: policy(),
        localListEntry: { status: "Accepted" },
        now: NOW,
      }),
    ).toEqual({ kind: "accept", source: "localList" });
  });

  it.each(["Invalid", "Blocked", "Expired"])(
    "rejects a local-list %s identifier even with AllowOfflineTxForUnknownId=true (§3.5.4 MUST)",
    (status) => {
      expect(
        resolveLocalAuthorization({
          online: false,
          policy: policy({ allowOfflineTxForUnknownId: true }),
          localListEntry: { status },
          now: NOW,
        }),
      ).toEqual({ kind: "reject", source: "localList", status });
    },
  );

  it("rejects a cached Accepted identifier whose expiryDate has passed, as Expired (§3.5.4)", () => {
    expect(
      resolveLocalAuthorization({
        online: false,
        policy: policy({
          cacheEnabled: true,
          allowOfflineTxForUnknownId: true,
        }),
        cacheEntry: cached("Accepted", { expiresAt: PAST }),
        now: NOW,
      }),
    ).toEqual({ kind: "reject", source: "cache", status: "Expired" });
  });

  it("rejects a local-list Accepted identifier whose expiry has passed (C13.FR.06)", () => {
    expect(
      resolveLocalAuthorization({
        online: false,
        policy: policy({ allowOfflineTxForUnknownId: true }),
        localListEntry: { status: "Accepted", expiresAt: PAST },
        now: NOW,
      }),
    ).toEqual({ kind: "reject", source: "localList", status: "Expired" });
  });

  it("does not check local-list expiry when the policy says the list carries none (C13.FR.02)", () => {
    expect(
      resolveLocalAuthorization({
        online: false,
        policy: policy({ localListChecksExpiry: false }),
        localListEntry: { status: "Accepted", expiresAt: PAST },
        now: NOW,
      }),
    ).toEqual({ kind: "accept", source: "localList" });
  });

  it("rejects a cached Blocked identifier even with AllowOfflineTxForUnknownId=true", () => {
    expect(
      resolveLocalAuthorization({
        online: false,
        policy: policy({
          cacheEnabled: true,
          allowOfflineTxForUnknownId: true,
        }),
        cacheEntry: cached("Blocked"),
        now: NOW,
      }),
    ).toEqual({ kind: "reject", source: "cache", status: "Blocked" });
  });

  it("local list wins over the cache offline (§3.5.3, C13.FR.01)", () => {
    expect(
      resolveLocalAuthorization({
        online: false,
        policy: policy({ cacheEnabled: true }),
        localListEntry: { status: "Blocked" },
        cacheEntry: cached("Accepted"),
        now: NOW,
      }),
    ).toEqual({ kind: "reject", source: "localList", status: "Blocked" });
    expect(
      resolveLocalAuthorization({
        online: false,
        policy: policy({ cacheEnabled: true }),
        localListEntry: { status: "Accepted" },
        cacheEntry: cached("Blocked"),
        now: NOW,
      }),
    ).toEqual({ kind: "accept", source: "localList" });
  });

  describe("LocalAuthorizeOffline=false", () => {
    it("does not accept a known valid identifier: it is treated as unknown", () => {
      expect(
        resolveLocalAuthorization({
          online: false,
          policy: policy({ cacheEnabled: true, localAuthorizeOffline: false }),
          cacheEntry: cached("Accepted"),
          now: NOW,
        }),
      ).toEqual({
        kind: "reject",
        source: "unknownOffline",
        status: "Invalid",
      });
      expect(
        resolveLocalAuthorization({
          online: false,
          policy: policy({
            localAuthorizeOffline: false,
            allowOfflineTxForUnknownId: true,
          }),
          localListEntry: { status: "Accepted" },
          now: NOW,
        }),
      ).toEqual({ kind: "accept", source: "unknownOffline" });
    });

    it("still rejects a known invalid identifier, never treating it as unknown", () => {
      expect(
        resolveLocalAuthorization({
          online: false,
          policy: policy({
            localAuthorizeOffline: false,
            allowOfflineTxForUnknownId: true,
          }),
          localListEntry: { status: "Blocked" },
          now: NOW,
        }),
      ).toEqual({ kind: "reject", source: "localList", status: "Blocked" });
    });
  });

  describe("cache lifetime (2.x AuthCacheLifeTime, C10.FR.08)", () => {
    it("treats an entry past its lifetime as absent from the cache", () => {
      expect(
        resolveLocalAuthorization({
          online: false,
          policy: policy({ cacheEnabled: true, cacheLifetimeSeconds: 5 }),
          cacheEntry: cached("Accepted"), // updated 10 s ago
          now: NOW,
        }),
      ).toEqual({
        kind: "reject",
        source: "unknownOffline",
        status: "Invalid",
      });
    });

    it("keeps an entry within its lifetime", () => {
      expect(
        resolveLocalAuthorization({
          online: false,
          policy: policy({ cacheEnabled: true, cacheLifetimeSeconds: 60 }),
          cacheEntry: cached("Accepted"),
          now: NOW,
        }),
      ).toEqual({ kind: "accept", source: "cache" });
    });

    it("lets an entry's own expiry override the lifetime (C10.FR.13)", () => {
      expect(
        resolveLocalAuthorization({
          online: false,
          // Updated 10 s ago, lifetime 5 s, but cacheExpiryDateTime ahead.
          policy: policy({ cacheEnabled: true, cacheLifetimeSeconds: 5 }),
          cacheEntry: cached("Accepted", { expiresAt: FUTURE }),
          now: NOW,
        }),
      ).toEqual({ kind: "accept", source: "cache" });
    });

    it("expires an entry at its own expiry even within the lifetime", () => {
      expect(
        resolveLocalAuthorization({
          online: false,
          policy: policy({ cacheEnabled: true, cacheLifetimeSeconds: 3600 }),
          cacheEntry: cached("Accepted", { expiresAt: PAST }),
          now: NOW,
        }),
      ).toEqual({ kind: "reject", source: "cache", status: "Expired" });
    });
  });
});
