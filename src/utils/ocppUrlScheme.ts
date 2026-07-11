/**
 * Adapt a Central System URL's scheme to the selected OCPP transport (#164).
 *
 * SOAP dialects (1.2 / 1.5 / 1.6-SOAP) speak HTTP; JSON dialects speak
 * WebSocket. When the operator switches transport we flip only an
 * *incompatible* scheme and leave everything after it — host, port, path —
 * untouched, since the correct SOAP endpoint path can't be inferred. A URL that
 * is already compatible, or uses some other scheme the user typed on purpose,
 * is returned unchanged. Secure stays secure: `wss` <-> `https`, `ws` <-> `http`.
 */
export function adaptCentralSystemUrlScheme(
  url: string,
  toSoap: boolean,
): string {
  if (toSoap) {
    if (url.startsWith("ws://")) return `http://${url.slice(5)}`;
    if (url.startsWith("wss://")) return `https://${url.slice(6)}`;
    return url;
  }
  if (url.startsWith("http://")) return `ws://${url.slice(7)}`;
  if (url.startsWith("https://")) return `wss://${url.slice(8)}`;
  return url;
}
