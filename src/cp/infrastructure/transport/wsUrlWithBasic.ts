/**
 * Browser WebSocket cannot set an `Authorization: Basic` header, so when this
 * module is loaded in a browser we fall back to a URL query parameter that
 * many CSMS implementations accept (e.g. `ocpp_ws_secret`). CLI runtimes (Bun
 * / Node `ws`) send the credentials as a real HTTP Basic header instead.
 */
import {
  OCPP_WEBSOCKET_PROTOCOL_16,
  OCPP_WEBSOCKET_PROTOCOL_201,
  ocppVersionToSubprotocol,
} from "./profile/subprotocols";

export {
  OCPP_WEBSOCKET_PROTOCOL_16,
  OCPP_WEBSOCKET_PROTOCOL_201,
  ocppVersionToSubprotocol,
};

export const OCPP_BROWSER_WS_SECRET_QUERY_PARAM = "ocpp_ws_secret";

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
  /** Extra raw HTTP headers attached to the WebSocket upgrade request.
   *  Only emitted when running in the Bun/Node CLI runtime — the DOM
   *  WebSocket constructor doesn't accept headers. Useful for driving a
   *  header-routing proxy in front of the CSMS. */
  extraHeaders?: Record<string, string>;
  /** Extra Sec-WebSocket-Protocol tokens appended to the OCPP version
   *  subprotocol. OCPP servers pick the first recognised version token
   *  and ignore the rest, so extras are safe to add and become visible
   *  to upstream routers that match on subprotocol. */
  extraSubprotocols?: ReadonlyArray<string>;
  /** OCPP version string (e.g. "OCPP-1.6J", "OCPP-2.0.1"). Defaults to 1.6. */
  ocppVersion?: string;
}): WebSocket {
  const url = buildOcppWebSocketUrl(params);
  const versionProtocol = ocppVersionToSubprotocol(params.ocppVersion ?? "");
  const protocols = [versionProtocol, ...(params.extraSubprotocols ?? [])];
  const extraHeaders = params.extraHeaders ?? {};
  const hasExtraHeaders = Object.keys(extraHeaders).length > 0;
  if (!isBrowserRuntime() && (params.basicAuth?.password || hasExtraHeaders)) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (params.basicAuth?.password) {
      headers.Authorization = buildOcppBasicAuthorization(params.basicAuth);
    }
    return new (WebSocket as unknown as WebSocketWithHeaders)(url, {
      protocols,
      headers,
    });
  }
  return new WebSocket(url, protocols);
}
