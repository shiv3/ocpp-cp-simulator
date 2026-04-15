/**
 * Browser WebSocket cannot set `Authorization: Basic` and does not reliably send
 * URL userinfo as Basic on the wire. CSMS accepts the same password via query
 * when `CSMS_OCPP_CP_QUERY_PASSWORD_PARAM` matches this name (default `ocpp_ws_secret`).
 */
export const OCPP_BROWSER_WS_SECRET_QUERY_PARAM = "ocpp_ws_secret";

export function isBrowserRuntime(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: unknown }).document !== "undefined"
  );
}

export function buildOcppWebSocketUrl(params: {
  baseUrl: string;
  chargePointId: string;
  basicAuth: { username: string; password: string } | null;
}): string {
  const url = new URL(params.baseUrl);
  let appendQuerySecret = false;
  if (params.basicAuth?.password) {
    if (isBrowserRuntime()) {
      appendQuerySecret = true;
      url.username = "";
      url.password = "";
    } else {
      url.username = params.basicAuth.username;
      url.password = params.basicAuth.password;
    }
  }
  let full = `${url.toString()}${params.chargePointId}`;
  if (appendQuerySecret && params.basicAuth) {
    const sep = full.includes("?") ? "&" : "?";
    full += `${sep}${OCPP_BROWSER_WS_SECRET_QUERY_PARAM}=${encodeURIComponent(params.basicAuth.password)}`;
  }
  return full;
}
