/**
 * Browser WebSocket cannot set an `Authorization: Basic` header, so when this
 * module is loaded in a browser we fall back to a URL query parameter that
 * many CSMS implementations accept (e.g. `ocpp_ws_secret`). CLI runtimes (Bun
 * / Node `ws`) send the credentials as a real HTTP Basic header instead.
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

// Bun/Node `ws` accept `{ protocols, headers }` as the 2nd arg, but the DOM
// lib's WebSocket constructor does not. The whole module compiles under both
// tsconfigs (CLI=bun-types, app=DOM), so cast through a local type.
type WebSocketWithHeaders = new (
  url: string,
  options: {
    protocols?: string | string[];
    headers?: Record<string, string>;
  },
) => WebSocket;

export function openOcppWebSocket(params: {
  baseUrl: string;
  chargePointId: string;
  basicAuth: BasicAuthSettings | null;
}): WebSocket {
  const url = buildOcppWebSocketUrl(params);
  if (!isBrowserRuntime() && params.basicAuth?.password) {
    return new (WebSocket as unknown as WebSocketWithHeaders)(url, {
      protocols: [OCPP_WEBSOCKET_PROTOCOL],
      headers: {
        Authorization: buildOcppBasicAuthorization(params.basicAuth),
      },
    });
  }
  return new WebSocket(url, [OCPP_WEBSOCKET_PROTOCOL]);
}
