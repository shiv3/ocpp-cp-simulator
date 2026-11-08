import "reflect-metadata";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

/** Test-only certificate builders shared by the certificate-store tests. */

const EC_ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

export interface TestAuthority {
  pem: string;
  name: string;
  keys: CryptoKeyPair;
}

function validity(options: IssuedOptions = {}) {
  const now = Date.now();
  return {
    notBefore: new Date(now + (options.notBeforeOffsetMs ?? -60_000)),
    notAfter: new Date(now + (options.notAfterOffsetMs ?? 86_400_000)),
  };
}

export async function selfSignedRoot(
  serialNumber: string,
  cn: string,
): Promise<TestAuthority> {
  const keys = await crypto.subtle.generateKey(EC_ALG, true, [
    "sign",
    "verify",
  ]);
  const name = `CN=${cn},O=Example`;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber,
    name,
    ...validity(),
    signingAlgorithm: EC_ALG,
    keys,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  return { pem: cert.toString("pem"), name, keys };
}

export interface IssuedOptions {
  /** Override the default validity period (a minute ago, a day ahead). */
  notBefore?: Date;
  notAfter?: Date;
  /** OCSP responder URL put in an Authority Information Access extension
   *  (#537, M06). */
  ocspUrl?: string;
  /** Validity period, in ms from now (default -60 s to +1 day). */
  notBeforeOffsetMs?: number;
  notAfterOffsetMs?: number;
}

function aiaExtensions({ ocspUrl }: IssuedOptions): x509.Extension[] {
  return ocspUrl
    ? [new x509.AuthorityInfoAccessExtension({ ocsp: [ocspUrl] })]
    : [];
}

/** A CA certificate issued by `issuer` (a sub-CA in a chain). */
export async function subCa(
  serialNumber: string,
  cn: string,
  issuer: TestAuthority,
  options: IssuedOptions = {},
): Promise<TestAuthority> {
  const keys = await crypto.subtle.generateKey(EC_ALG, true, [
    "sign",
    "verify",
  ]);
  const name = `CN=${cn},O=Example`;
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber,
    subject: name,
    issuer: issuer.name,
    ...validity(),
    signingAlgorithm: EC_ALG,
    publicKey: keys.publicKey,
    signingKey: issuer.keys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      ...aiaExtensions(options),
    ],
  });
  return { pem: cert.toString("pem"), name, keys };
}

/**
 * `pem` re-encoded with two bytes appended after its DER structure. Since
 * @peculiar/x509 v3, parsing such a certificate throws instead of ignoring
 * the extra bytes.
 */
export function withTrailingDerBytes(pem: string): string {
  const der = new Uint8Array(x509.PemConverter.decodeFirst(pem));
  const padded = new Uint8Array(der.length + 2);
  padded.set(der);
  return x509.PemConverter.encode(padded, x509.PemConverter.CertificateTag);
}

/** A leaf certificate for `csrPem`'s public key, signed by `issuer`. */
export async function leafForCsr(
  serialNumber: string,
  csrPem: string,
  issuer: TestAuthority,
  options: IssuedOptions = {},
): Promise<string> {
  const csr = new x509.Pkcs10CertificateRequest(csrPem);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber,
    subject: csr.subject,
    issuer: issuer.name,
    ...validity(options),
    ...(options.notBefore ? { notBefore: options.notBefore } : {}),
    ...(options.notAfter ? { notAfter: options.notAfter } : {}),
    signingAlgorithm: EC_ALG,
    publicKey: csr.publicKey,
    signingKey: issuer.keys.privateKey,
    extensions: aiaExtensions(options),
  });
  return cert.toString("pem");
}

export interface SigningLeafOptions {
  notBefore?: Date;
  notAfter?: Date;
  /** The CA that signs the leaf; absent: a self-signed certificate. */
  issuer?: TestAuthority;
}

/**
 * A firmware signing certificate (L01.FR.21 / L01.FR.23) with a validity
 * period of the test's choosing, so an expired or not-yet-valid one can be
 * built. Self-signed unless `issuer` is given.
 */
export async function signingLeaf(
  options: SigningLeafOptions = {},
): Promise<string> {
  const keys = await crypto.subtle.generateKey(EC_ALG, true, [
    "sign",
    "verify",
  ]);
  const { notBefore, notAfter } = { ...validity(), ...options };
  const subject = "CN=Firmware signer,O=Example";
  const cert = options.issuer
    ? await x509.X509CertificateGenerator.create({
        serialNumber: "0a1b",
        subject,
        issuer: options.issuer.name,
        notBefore,
        notAfter,
        signingAlgorithm: EC_ALG,
        publicKey: keys.publicKey,
        signingKey: options.issuer.keys.privateKey,
      })
    : await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "0a1b",
        name: subject,
        notBefore,
        notAfter,
        signingAlgorithm: EC_ALG,
        keys,
      });
  return cert.toString("pem");
}
