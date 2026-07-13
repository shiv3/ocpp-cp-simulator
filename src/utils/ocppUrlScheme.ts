// The default SteVe path segments for the two transports (#178). SteVe's
// JSON/WebSocket endpoint lives under `/websocket/`; its SOAP endpoint lives
// under `/services/` — different paths, not just a scheme change. We only
// ever rewrite the path when it is *exactly* this well-known boilerplate, so
// a URL the operator has customized (any other path) is left untouched.
const STEVE_JSON_PATH = "/steve/websocket/CentralSystemService/";
const STEVE_SOAP_PATH = "/steve/services/CentralSystemService";

function swapStevePath(url: string, toSoap: boolean): string {
  if (toSoap && url.endsWith(STEVE_JSON_PATH)) {
    return url.slice(0, -STEVE_JSON_PATH.length) + STEVE_SOAP_PATH;
  }
  if (!toSoap && url.endsWith(STEVE_SOAP_PATH)) {
    return url.slice(0, -STEVE_SOAP_PATH.length) + STEVE_JSON_PATH;
  }
  return url;
}

/**
 * Adapt a Central System URL's scheme to the selected OCPP transport (#164).
 *
 * SOAP dialects (1.2 / 1.5 / 1.6-SOAP) speak HTTP; JSON dialects speak
 * WebSocket. When the operator switches transport we flip only an
 * *incompatible* scheme and leave everything after it — host, port, path —
 * untouched, since the correct SOAP endpoint path can't be inferred in the
 * general case. A URL that is already compatible, or uses some other scheme
 * the user typed on purpose, is returned unchanged. Secure stays secure:
 * `wss` <-> `https`, `ws` <-> `http`.
 *
 * One exception (#178): the well-known SteVe default path is transport-
 * specific (`/websocket/...` for JSON vs `/services/...` for SOAP), so when
 * an incompatible-scheme URL's path is exactly that boilerplate, the path is
 * rewritten alongside the scheme. Any other path is left alone.
 */
export function adaptCentralSystemUrlScheme(
  url: string,
  toSoap: boolean,
): string {
  // URL schemes are case-insensitive (RFC 3986), so match accordingly. Each
  // prefix has the same length regardless of case, so the slice offsets hold.
  if (toSoap) {
    if (/^ws:\/\//i.test(url))
      return swapStevePath(`http://${url.slice(5)}`, true);
    if (/^wss:\/\//i.test(url))
      return swapStevePath(`https://${url.slice(6)}`, true);
    return url;
  }
  if (/^http:\/\//i.test(url))
    return swapStevePath(`ws://${url.slice(7)}`, false);
  if (/^https:\/\//i.test(url))
    return swapStevePath(`wss://${url.slice(8)}`, false);
  return url;
}
