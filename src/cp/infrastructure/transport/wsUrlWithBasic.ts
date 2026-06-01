/**
 * Browser WebSocket cannot set `Authorization: Basic` and does not reliably send
 * URL userinfo as Basic on the wire. CSMS accepts the same password via query
 * when `CSMS_OCPP_CP_QUERY_PASSWORD_PARAM` matches this name (default `ocpp_ws_secret`).
 */
export const OCPP_BROWSER_WS_SECRET_QUERY_PARAM = "ocpp_ws_secret";
export const OCPP_WEBSOCKET_PROTOCOL = "ocpp1.6";

export interface BasicAuthSettings {
  username: string;
  password: string;
}

export function isBrowserRuntime(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: unknown }).document !== "undefined"
  );
}

export function buildOcppWebSocketUrl(params: {
  baseUrl: string;
  chargePointId: string;
  basicAuth: BasicAuthSettings | null;
}): string {
  const url = new URL(params.baseUrl);
  if (isBrowserRuntime() && params.basicAuth?.password) {
    url.searchParams.set(
      OCPP_BROWSER_WS_SECRET_QUERY_PARAM,
      params.basicAuth.password,
    );
  }
  url.pathname += params.chargePointId;
  return url.toString();
}

export function buildOcppBasicAuthorization(
  basicAuth: BasicAuthSettings,
): string {
  return `Basic ${btoa(`${basicAuth.username}:${basicAuth.password}`)}`;
}

export function openOcppWebSocket(params: {
  baseUrl: string;
  chargePointId: string;
  basicAuth: BasicAuthSettings | null;
}): WebSocket {
  const url = buildOcppWebSocketUrl(params);
  if (!isBrowserRuntime() && params.basicAuth?.password) {
    return new WebSocket(url, {
      protocols: [OCPP_WEBSOCKET_PROTOCOL],
      headers: {
        Authorization: buildOcppBasicAuthorization(params.basicAuth),
      },
    });
  }
  return new WebSocket(url, [OCPP_WEBSOCKET_PROTOCOL]);
}
