/**
 * TLS material for a security-profile 2/3 connection. The transport that
 * opens the socket reads it; the charge point only carries it.
 */
export interface OcppTlsOptions {
  readonly ca?: string;
  readonly cert?: string;
  readonly key?: string;
  readonly rejectUnauthorized?: boolean;
  readonly serverName?: string;
}
