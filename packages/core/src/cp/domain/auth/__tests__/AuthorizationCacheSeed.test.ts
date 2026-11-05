import { describe, expect, it } from "vitest";
import { AuthorizationCache } from "../AuthorizationCache";
import {
  AUTHORIZATION_CACHE_SEED_MAX,
  idTokenMaxLength,
  InvalidAuthorizationCacheSeedError,
  type AuthorizationCacheSeedEntry,
} from "../AuthorizationCacheSeed";
import { LocalAuthListManager } from "../LocalAuthList";
import { StationAuthorization } from "../StationAuthorization";
import { Logger } from "../../../shared/Logger";

const NOW = Date.parse("2026-10-29T12:00:00Z");

function build(cacheEnabled = false, maxIdTokenLength = 20) {
  const cache = new AuthorizationCache("CP", null, { now: () => NOW });
  const auth = new StationAuthorization({
    cache,
    localList: new LocalAuthListManager(new Logger()),
    policy: () => ({
      cacheEnabled,
      localListEnabled: true,
      localPreAuthorize: false,
      localAuthorizeOffline: true,
      allowOfflineTxForUnknownId: false,
      cacheLifetimeSeconds: null,
      localListChecksExpiry: true,
    }),
    now: () => NOW,
    idTokenMaxLength: maxIdTokenLength,
  });
  return { auth, cache };
}

describe("StationAuthorization.seedCache (#452 control seam)", () => {
  it("writes the entries even while the cache is disabled", () => {
    const { auth, cache } = build(false);
    expect(
      auth.seedCache([
        {
          idToken: "A",
          status: "Accepted",
          expiresAt: "2026-10-30T00:00:00.000Z",
          parentId: "G",
        },
        { idToken: "B", status: "Blocked" },
      ]),
    ).toBe(2);
    expect(cache.get("A")).toMatchObject({
      status: "Accepted",
      expiresAt: Date.parse("2026-10-30T00:00:00.000Z"),
      parentId: "G",
    });
    expect(cache.get("B")?.status).toBe("Blocked");
  });

  it.each<[string, AuthorizationCacheSeedEntry[]]>([
    ["an empty idToken", [{ idToken: "", status: "Accepted" }]],
    [
      "an unknown status",
      [
        {
          idToken: "A",
          status: "Maybe",
        } as unknown as AuthorizationCacheSeedEntry,
      ],
    ],
    [
      "an unparseable expiry",
      [{ idToken: "A", status: "Accepted", expiresAt: "soon" }],
    ],
    ...["2026", "0", "soon 1", "2026-10-30", "2026-10-30T00:00:00"].map(
      (expiresAt): [string, AuthorizationCacheSeedEntry[]] => [
        `a non-ISO expiry ${JSON.stringify(expiresAt)}`,
        [{ idToken: "A", status: "Accepted", expiresAt }],
      ],
    ),
    ["an empty parentId", [{ idToken: "A", status: "Accepted", parentId: "" }]],
    [
      "a duplicate idToken",
      [
        { idToken: "A", status: "Accepted" },
        { idToken: "A", status: "Blocked" },
      ],
    ],
  ])("refuses %s and writes nothing", (_label, entries) => {
    const { auth, cache } = build(true);
    const valid: AuthorizationCacheSeedEntry = {
      idToken: "OK",
      status: "Accepted",
    };
    expect(() => auth.seedCache([valid, ...entries])).toThrow(
      InvalidAuthorizationCacheSeedError,
    );
    expect(cache.size()).toBe(0);
  });

  it("refuses more entries than the cache holds", () => {
    const { auth } = build(true);
    const entries = Array.from(
      { length: AUTHORIZATION_CACHE_SEED_MAX + 1 },
      (_, i): AuthorizationCacheSeedEntry => ({
        idToken: `T${i}`,
        status: "Accepted",
      }),
    );
    expect(() => auth.seedCache(entries)).toThrow(
      InvalidAuthorizationCacheSeedError,
    );
  });
});

describe("idTokenMaxLength (#452)", () => {
  it.each([
    // 1.6 Part 2 §7.28 IdToken: CiString20Type (1.2, 1.5 and 1.6S alike).
    ["OCPP-1.2", 20],
    ["OCPP-1.5", 20],
    ["OCPP-1.6J", 20],
    ["OCPP-1.6S", 20],
    // IdTokenType.idToken: identifierString[0..36] in 2.0.1, [0..255] in 2.1.
    ["OCPP-2.0.1", 36],
    ["OCPP-2.1", 255],
  ])("%s → %i", (version, max) => {
    expect(idTokenMaxLength(version)).toBe(max);
  });
});

describe("StationAuthorization.seedCache — per-version length", () => {
  it.each([20, 36, 255])(
    "admits an idToken and a parentId of %i characters, refuses one more",
    (max) => {
      const { auth, cache } = build(true, max);
      const at = "x".repeat(max);
      expect(
        auth.seedCache([{ idToken: at, status: "Accepted", parentId: at }]),
      ).toBe(1);
      expect(() =>
        auth.seedCache([{ idToken: at + "y", status: "Accepted" }]),
      ).toThrow(InvalidAuthorizationCacheSeedError);
      expect(() =>
        auth.seedCache([
          { idToken: "OK", status: "Accepted", parentId: at + "y" },
        ]),
      ).toThrow(InvalidAuthorizationCacheSeedError);
      expect(cache.size()).toBe(1);
    },
  );
});

describe("StationAuthorization.cacheView", () => {
  it("reports the switch and every entry with ISO timestamps", () => {
    const { auth } = build(true);
    auth.seedCache([
      {
        idToken: "A",
        status: "Accepted",
        expiresAt: "2026-10-30T00:00:00.000Z",
      },
    ]);
    expect(auth.cacheView()).toEqual({
      enabled: true,
      entries: [
        {
          idToken: "A",
          status: "Accepted",
          expiresAt: "2026-10-30T00:00:00.000Z",
          insertedAt: "2026-10-29T12:00:00.000Z",
          updatedAt: "2026-10-29T12:00:00.000Z",
        },
      ],
    });
  });

  it("reports a disabled, empty cache", () => {
    expect(build(false).auth.cacheView()).toEqual({
      enabled: false,
      entries: [],
    });
  });
});
