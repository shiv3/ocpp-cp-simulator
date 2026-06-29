import "reflect-metadata";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

export interface GeneratedCsr {
  csr: x509.Pkcs10CertificateRequest;
  pem: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export async function generateCsr(
  serial: string,
  cpoName: string,
): Promise<GeneratedCsr> {
  const keys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${serial},O=${cpoName}`,
    keys,
    signingAlgorithm: alg,
  });
  const pem = csr.toString("pem");

  return {
    csr,
    pem,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  };
}
