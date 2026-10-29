import { describe, expect, it } from "vitest";
import {
  authorizationResultFromIdTokenInfo,
  cacheableIdToken,
} from "../authorizationCacheV201";

describe("authorizationResultFromIdTokenInfo (#452, C10)", () => {
  it("keeps the status alone when nothing else is given", () => {
    expect(authorizationResultFromIdTokenInfo({ status: "Blocked" })).toEqual({
      status: "Blocked",
    });
  });

  it("maps cacheExpiryDateTime to expiresAt and groupIdToken to parentId", () => {
    expect(
      authorizationResultFromIdTokenInfo({
        status: "Accepted",
        cacheExpiryDateTime: "2026-10-30T00:00:00.000Z",
        groupIdToken: { idToken: "GROUP-1", type: "Central" },
      }),
    ).toEqual({
      status: "Accepted",
      expiresAt: Date.parse("2026-10-30T00:00:00.000Z"),
      parentId: "GROUP-1",
    });
  });

  it("ignores an unparseable cacheExpiryDateTime (lifetime applies)", () => {
    expect(
      authorizationResultFromIdTokenInfo({
        status: "Accepted",
        cacheExpiryDateTime: "not a date",
      }),
    ).toEqual({ status: "Accepted" });
  });
});

describe("cacheableIdToken", () => {
  it("returns the identifier of a real token", () => {
    expect(cacheableIdToken({ idToken: "TAG-1", type: "ISO14443" })).toBe(
      "TAG-1",
    );
  });

  it.each([
    ["no token", undefined],
    ["an empty token", { idToken: "", type: "ISO14443" as const }],
    ["NoAuthorization", { idToken: "X", type: "NoAuthorization" as const }],
  ])("returns undefined for %s", (_label, token) => {
    expect(cacheableIdToken(token)).toBeUndefined();
  });
});
