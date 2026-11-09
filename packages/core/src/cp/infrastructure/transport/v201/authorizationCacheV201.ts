import type {
  IdTokenInfoType,
  IdTokenType,
} from "@ocpp-cp-simulator/ocpp/v201/types/authorize-response";
import type { CsmsAuthorizationResult } from "../../../domain/auth/StationAuthorization";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";

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

/**
 * #452: feed the CSMS's idTokenInfo on `idToken` to the Authorization
 * Cache (C10.FR.04 AuthorizeResponse, C10.FR.05 TransactionEventResponse).
 * Only real answers come here: the "Invalid" synthesized from a CALLERROR
 * is not a verdict and is never cached.
 */
export function recordIdTokenInfo(
  chargePoint: Pick<ChargePoint, "recordAuthorizationResult">,
  idToken: Pick<IdTokenType, "idToken" | "type"> | undefined,
  idTokenInfo: IdTokenInfoType | undefined,
): void {
  const key = cacheableIdToken(idToken);
  if (key === undefined || idTokenInfo === undefined) return;
  chargePoint.recordAuthorizationResult(
    key,
    authorizationResultFromIdTokenInfo(idTokenInfo),
  );
}
