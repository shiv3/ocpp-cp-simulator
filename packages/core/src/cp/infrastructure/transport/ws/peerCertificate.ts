/**
 * Peer certificate chain helpers for the Node `ws` fallback: the root a
 * handshake validated against, as PEM. Moved verbatim from `wsUrlWithBasic.ts`
 * (#877); that module re-exports `peerChainRootPem`.
 */

/** The part of a Node `PeerCertificate` the root lookup reads. */
export interface PeerCertificateLike {
  readonly raw?: Uint8Array;
  readonly issuerCertificate?: PeerCertificateLike;
}

function derToPem(der: Uint8Array): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/**
 * Walks `issuerCertificate` from the peer certificate to the certificate that
 * is its own issuer (Node resolves the last link from the trust store) and
 * returns it as PEM. `undefined` when the chain does not end in one, so the
 * caller keeps the wider answer.
 */
export function peerChainRootPem(
  peer: PeerCertificateLike | undefined,
): string | undefined {
  let cert = peer;
  for (let depth = 0; cert && depth < 16; depth += 1) {
    const issuer = cert.issuerCertificate;
    if (issuer === cert) return cert.raw ? derToPem(cert.raw) : undefined;
    cert = issuer;
  }
  return undefined;
}
