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

function validity() {
  const now = Date.now();
  return {
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
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

/** A CA certificate issued by `issuer` (a sub-CA in a chain). */
export async function subCa(
  serialNumber: string,
  cn: string,
  issuer: TestAuthority,
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
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  return { pem: cert.toString("pem"), name, keys };
}

/** A leaf certificate for `csrPem`'s public key, signed by `issuer`. */
export async function leafForCsr(
  serialNumber: string,
  csrPem: string,
  issuer: TestAuthority,
): Promise<string> {
  const csr = new x509.Pkcs10CertificateRequest(csrPem);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber,
    subject: csr.subject,
    issuer: issuer.name,
    ...validity(),
    signingAlgorithm: EC_ALG,
    publicKey: csr.publicKey,
    signingKey: issuer.keys.privateKey,
  });
  return cert.toString("pem");
}
