import "reflect-metadata";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

export interface CsrGenerationOptions {
  /** Key algorithm for the CSR. Default: "ECDSA" (P-256, SHA-256) */
  keyAlgorithm?: "ECDSA" | "RSA";
  /** Line endings for the emitted PEM. Default: "lf" */
  pemLineEndings?: "lf" | "crlf";
}

export interface GeneratedCsr {
  csr: x509.Pkcs10CertificateRequest;
  pem: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export async function generateCsr(
  serial: string,
  cpoName: string,
  options?: CsrGenerationOptions,
): Promise<GeneratedCsr> {
  const keyAlgorithm = options?.keyAlgorithm ?? "ECDSA";
  const pemLineEndings = options?.pemLineEndings ?? "lf";

  let alg:
    | {
        name: "ECDSA";
        namedCurve: "P-256";
        hash: "SHA-256";
      }
    | {
        name: "RSASSA-PKCS1-v1_5";
        modulusLength: 2048;
        publicExponent: Uint8Array;
        hash: "SHA-256";
      };
  let keyGenAlg: EcKeyGenParams | RsaHashedKeyGenParams;

  if (keyAlgorithm === "RSA") {
    alg = {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    };
    keyGenAlg = {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    };
  } else {
    // ECDSA (default)
    alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
    keyGenAlg = { name: "ECDSA", namedCurve: "P-256" };
  }

  const keys = await crypto.subtle.generateKey(keyGenAlg, true, [
    "sign",
    "verify",
  ]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${serial},O=${cpoName}`,
    keys,
    signingAlgorithm: alg,
  });

  let pem = csr.toString("pem");

  // Apply CRLF line endings if requested
  if (pemLineEndings === "crlf") {
    // Convert LF to CRLF, but avoid double-converting existing CRLF
    pem = pem.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  }

  return {
    csr,
    pem,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  };
}
