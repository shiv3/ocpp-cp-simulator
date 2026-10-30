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

/** Hash data as any side may write it: any algorithm name, any casing. */
interface WireCertificateHashData {
  hashAlgorithm: string;
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
 * - serialNumber: lower-case hex without leading zeroes (#537), as the
 *   1.6 whitepaper and the 2.x CertificateHashDataType require; the
 *   sign-padding byte is already stripped by @peculiar/x509.
 *
 * `issuerPem`, when given, is the certificate that signed `pem`: its public
 * key feeds issuerKeyHash (a chain member, M03.FR.05). Omitted, the
 * certificate is treated as self-signed, as above.
 */
export async function computeCertificateHashData(
  pem: string,
  issuerPem?: string,
): Promise<CertificateHashData> {
  const cert = new x509.X509Certificate(pem);
  // An issued certificate (a chain member, #456) is identified by its
  // issuer's key; without an issuer the certificate is taken as self-signed.
  const keySource = issuerPem ? new x509.X509Certificate(issuerPem) : cert;
  const issuerNameHash = await crypto.subtle.digest(
    "SHA-256",
    cert.issuerName.toArrayBuffer(),
  );
  const issuerKeyHash = await keySource.publicKey.getKeyIdentifier("SHA-256");

  return {
    hashAlgorithm: "SHA256",
    issuerNameHash: toHex(issuerNameHash),
    issuerKeyHash: toHex(issuerKeyHash),
    serialNumber: normalizeSerialNumber(cert.serialNumber),
  };
}

/**
 * A hex serialNumber in its wire form (#537): lower case, no leading
 * zeroes, and `"0"` for an all-zero value. An empty string stays empty.
 */
export function normalizeSerialNumber(hex: string): string {
  const lower = hex.toLowerCase();
  const stripped = lower.replace(/^0+/, "");
  return stripped === "" && lower !== "" ? "0" : stripped;
}

/**
 * Case-insensitive field comparison — CSMS implementations vary on hex
 * casing. serialNumber is compared without leading zeroes (#537), so a
 * CSMS sending `0a` or `a` matches either stored form.
 */
export function certificateHashDataEquals(
  a: WireCertificateHashData,
  b: WireCertificateHashData,
): boolean {
  return (
    a.hashAlgorithm === b.hashAlgorithm &&
    a.issuerNameHash.toLowerCase() === b.issuerNameHash.toLowerCase() &&
    a.issuerKeyHash.toLowerCase() === b.issuerKeyHash.toLowerCase() &&
    normalizeSerialNumber(a.serialNumber) ===
      normalizeSerialNumber(b.serialNumber)
  );
}

/** OCPP 2.x `OCSPRequestDataType`: a certificate's hash data plus the
 *  responder to ask about it (M06). */
export interface OcspRequestData extends CertificateHashData {
  responderURL: string;
}

/**
 * The OCSP responder URL of `pem`'s Authority Information Access
 * extension (#537), or `undefined` when it names none. OCPP requires a
 * responderURL for any certificate whose status is requested (M06
 * remark), so a certificate without one is never asked about.
 */
export function ocspResponderUrl(pem: string): string | undefined {
  const aia = new x509.X509Certificate(pem).getExtension(
    x509.AuthorityInfoAccessExtension,
  );
  return aia?.ocsp.find((name) => name.type === "url")?.value;
}

const PEM_CERTIFICATE_RE =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Whether `pem` is one of the certificates of `bundle`, a PEM file that may
 * hold several certificates and text around them (a `--tls-ca` file).
 * Compared on the DER encoding, so line endings and wrapping do not matter;
 * a block that does not parse is ignored.
 */
export function isCertificateInBundle(pem: string, bundle: string): boolean {
  const der = new Uint8Array(new x509.X509Certificate(pem).rawData);
  return (bundle.match(PEM_CERTIFICATE_RE) ?? []).some((block) => {
    try {
      const other = new Uint8Array(new x509.X509Certificate(block).rawData);
      return other.length === der.length && other.every((b, i) => b === der[i]);
    } catch {
      return false;
    }
  });
}
