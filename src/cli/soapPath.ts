/**
 * SOAP ChargePointService path convention, shared by the callback server
 * (httpServer route matching) and callback-URL derivation (soapCallbackUrl).
 * Keeping the normalizer, the service suffix, and the route pattern in one
 * place stops the advertised callback URL from drifting away from the routes
 * that must accept it.
 */

/** Final path segment of a SOAP ChargePointService endpoint. */
export const SOAP_SERVICE_SUFFIX = "ChargePointService";

/**
 * Matches "<basePath>/<cpId>/ChargePointService": group 1 = base path (may be
 * ""), group 2 = the (percent-encoded) cpId segment. No global flag, so it is
 * safe to share this instance across .exec() calls.
 */
export const SOAP_CHARGE_POINT_SERVICE_ROUTE = new RegExp(
  `^(.*)/([^/]+)/${SOAP_SERVICE_SUFFIX}$`,
);

/** Ensure a leading slash and strip trailing slashes; "" and "/" collapse to "/". */
export function normalizeSoapPath(value: string): string {
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  const trimmed = withLeading.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
}
