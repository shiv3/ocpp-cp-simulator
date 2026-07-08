import "reflect-metadata";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

export type HashAlgorithm = "SHA256";

/** OCPP 1.6 Security Whitepaper `CertificateHashDataType`. */
export interface CertificateHashData {
  hashAlgorithm: HashAlgorithm;
  issuerNameHash: string;
  issuerKeyHash: string;
  serialNumber: string;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Computes the OCPP 1.6 Security Whitepaper `certificateHashData` for a
 * stored root certificate (GetInstalledCertificateIds / DeleteCertificate).
 * Root certificates are self-signed, so the "issuer" fields — which
 * normally identify the CA that signed the certificate under inspection —
 * resolve to the certificate's own subject name and public key.
 *
 * - issuerNameHash: SHA-256 over the DER encoding of the issuer Name.
 * - issuerKeyHash: SHA-256 over the subjectPublicKey BIT STRING content,
 *   excluding the tag, length, and leading "unused bits" octet — the RFC
 *   5280 §4.2.1.2 Subject Key Identifier method (1) formula, and the same
 *   value produced by OpenSSL's X509_pubkey_digest (the de facto
 *   reference implementation behind RFC 6960 issuerKeyHash in real-world
 *   CSMS stacks). Verified in certificateHash.test.ts two independent
 *   ways: against SHA-256 over the raw EC point exported via WebCrypto
 *   (`exportKey("raw", ...)` — for EC keys, exactly the BIT STRING
 *   content with no ASN.1 framing), and against known-answer hashes
 *   precomputed with `openssl asn1parse` + `openssl dgst -sha256` for a
 *   fixed certificate.
 * - serialNumber: hex string, sign-padding byte stripped by @peculiar/x509.
 */
export async function computeCertificateHashData(
  pem: string,
): Promise<CertificateHashData> {
  const cert = new x509.X509Certificate(pem);
  const issuerNameHash = await crypto.subtle.digest(
    "SHA-256",
    cert.issuerName.toArrayBuffer(),
  );
  const issuerKeyHash = await cert.publicKey.getKeyIdentifier("SHA-256");

  return {
    hashAlgorithm: "SHA256",
    issuerNameHash: toHex(issuerNameHash),
    issuerKeyHash: toHex(issuerKeyHash),
    serialNumber: cert.serialNumber,
  };
}

/** Case-insensitive field comparison — CSMS implementations vary on hex casing. */
export function certificateHashDataEquals(
  a: CertificateHashData,
  b: {
    hashAlgorithm: string;
    issuerNameHash: string;
    issuerKeyHash: string;
    serialNumber: string;
  },
): boolean {
  return (
    a.hashAlgorithm === b.hashAlgorithm &&
    a.issuerNameHash.toLowerCase() === b.issuerNameHash.toLowerCase() &&
    a.issuerKeyHash.toLowerCase() === b.issuerKeyHash.toLowerCase() &&
    a.serialNumber.toLowerCase() === b.serialNumber.toLowerCase()
  );
}
