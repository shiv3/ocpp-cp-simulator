import type {
  IdTokenInfoType,
  IdTokenType,
} from "../../../../ocpp/v201/types/authorize-response";
import type { CsmsAuthorizationResult } from "../../../domain/auth/StationAuthorization";

/**
 * OCPP 2.x idTokenInfo → the domain's CSMS verdict (#452; 2.0.1 Part 2
 * C10.FR.04/.05). `cacheExpiryDateTime` becomes the entry's own expiry,
 * which overrides `AuthCacheCtrlr.LifeTime` (C10.FR.13); a missing or
 * unparseable one leaves the lifetime in charge (C10.FR.08).
 * `groupIdToken` is kept as the parent id.
 */
export function authorizationResultFromIdTokenInfo(
  info: Pick<
    IdTokenInfoType,
    "status" | "cacheExpiryDateTime" | "groupIdToken"
  >,
): CsmsAuthorizationResult {
  const expiresAt =
    info.cacheExpiryDateTime !== undefined
      ? Date.parse(info.cacheExpiryDateTime)
      : NaN;
  return {
    status: info.status,
    ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
    ...(info.groupIdToken !== undefined
      ? { parentId: info.groupIdToken.idToken }
      : {}),
  };
}

/** The identifier a CSMS verdict can be cached under: none for a missing
 *  or empty token, nor for `NoAuthorization` (sent when no idToken was
 *  presented, 2.0.1 Part 2 §2.3.1 AuthCtrlr.Enabled). */
export function cacheableIdToken(
  token: Pick<IdTokenType, "idToken" | "type"> | undefined,
): string | undefined {
  if (token === undefined) return undefined;
  if (token.idToken === "" || token.type === "NoAuthorization")
    return undefined;
  return token.idToken;
}
