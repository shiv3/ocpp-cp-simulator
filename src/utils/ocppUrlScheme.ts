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

/**
 * Adapt a Central System URL's scheme to match a WebSocket security profile
 * (#178 item G), preserving the transport.
 *
 * OCPP 1.6 security profiles fix the transport security at connect time —
 * profile 1 uses an unsecured socket (`ws`), profiles 2 and 3 require TLS
 * (`wss`) — and `buildOcppWebSocketUrl` overwrites `url.protocol` accordingly.
 * Without this, the scheme the operator typed in the form silently diverges
 * from what actually goes on the wire once a profile is chosen. Flip only the
 * secure/insecure half of the scheme (`ws` <-> `wss`, `http` <-> `https`) so
 * the displayed URL stays honest; host, port and path are untouched, and a URL
 * whose scheme already matches (or is unrecognized) is returned unchanged.
 *
 * `secure` should be true for profiles 2/3 and false for profile 1; profile 0
 * enforces nothing, so callers should leave the URL alone rather than calling
 * this.
 */
export function adaptOcppUrlSecurity(url: string, secure: boolean): string {
  if (secure) {
    if (/^ws:\/\//i.test(url)) return `wss://${url.slice(5)}`;
    if (/^http:\/\//i.test(url)) return `https://${url.slice(7)}`;
    return url;
  }
  if (/^wss:\/\//i.test(url)) return `ws://${url.slice(6)}`;
  if (/^https:\/\//i.test(url)) return `http://${url.slice(8)}`;
  return url;
}
