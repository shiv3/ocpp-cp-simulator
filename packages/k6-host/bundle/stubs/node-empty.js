// Stands in for a `node:*` / `bun:*` builtin that only persistence, SOAP or
// TLS-client-certificate code touches: not reachable from an OCPP 1.6J station
// over ws://. Using it fails loudly instead of silently.
const fail = (name) => () => {
  throw new Error(`node builtin not available in k6: ${name}`);
};
export default new Proxy(
  {},
  { get: (_t, p) => (p === "__esModule" ? false : fail(String(p))) },
);
