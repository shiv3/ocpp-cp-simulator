import "reflect-metadata";
import { describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";
import {
  certificateHashDataEquals,
  computeCertificateHashData,
} from "../certificateHash";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

const EC_ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

async function selfSignedRootCert(serialNumber: string, cn: string) {
  const keys = await crypto.subtle.generateKey(EC_ALG, true, [
    "sign",
    "verify",
  ]);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber,
    name: `CN=${cn},O=Example`,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    signingAlgorithm: EC_ALG,
    keys,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  return { cert, pem: cert.toString("pem") };
}

describe("computeCertificateHashData", () => {
  it("computes issuerNameHash as SHA-256 over the DER-encoded issuer Name", async () => {
    const { cert, pem } = await selfSignedRootCert("01a2b3", "Test Root CA");
    const result = await computeCertificateHashData(pem);

    const expected = await crypto.subtle.digest(
      "SHA-256",
      cert.issuerName.toArrayBuffer(),
    );
    const expectedHex = Array.from(new Uint8Array(expected))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    expect(result.issuerNameHash).toBe(expectedHex);
    expect(result.issuerNameHash).toHaveLength(64);
  });

  /**
   * Independent cross-check that does NOT reuse @peculiar/x509's
   * `getKeyIdentifier` internals: export the certificate's public key as a
   * raw EC point via WebCrypto (`exportKey("raw", ...)` — the uncompressed
   * point, with no ASN.1 framing at all) and hash that directly. For an EC
   * key the BIT STRING content (minus the always-zero "unused bits" byte)
   * *is* the raw point, so this independently confirms issuerKeyHash is
   * "SHA-256 over the subjectPublicKey bits, no tag/length/unused-bits
   * byte" rather than e.g. a hash of the whole SubjectPublicKeyInfo DER.
   */
  it("computes issuerKeyHash matching an independent WebCrypto raw-point hash", async () => {
    const { cert, pem } = await selfSignedRootCert("01", "Test Root CA 2");
    const result = await computeCertificateHashData(pem);

    const cryptoKey = await cert.publicKey.export(EC_ALG, ["verify"]);
    const rawPoint = await crypto.subtle.exportKey("raw", cryptoKey);
    const expected = await crypto.subtle.digest("SHA-256", rawPoint);
    const expectedHex = Array.from(new Uint8Array(expected))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    expect(result.issuerKeyHash).toBe(expectedHex);
    expect(result.issuerKeyHash).toHaveLength(64);
  });

  it("reports hashAlgorithm SHA256 and a sign-padding-stripped hex serialNumber", async () => {
    const { pem } = await selfSignedRootCert("ff0102", "Serial Test");
    const result = await computeCertificateHashData(pem);

    expect(result.hashAlgorithm).toBe("SHA256");
    // DER requires a leading 0x00 pad byte when the high bit of the first
    // declared byte is set (0xff here) to keep the INTEGER non-negative;
    // the reported serial must not carry that padding.
    expect(result.serialNumber).toBe("ff0102");
  });

  it("produces different hashes for different keys/issuers", async () => {
    const a = await selfSignedRootCert("01", "Root A");
    const b = await selfSignedRootCert("01", "Root B");
    const hashA = await computeCertificateHashData(a.pem);
    const hashB = await computeCertificateHashData(b.pem);

    expect(hashA.issuerNameHash).not.toBe(hashB.issuerNameHash);
    expect(hashA.issuerKeyHash).not.toBe(hashB.issuerKeyHash);
  });
});

describe("certificateHashDataEquals", () => {
  it("compares case-insensitively across all fields", async () => {
    const { pem } = await selfSignedRootCert("0a", "Case Test");
    const hash = await computeCertificateHashData(pem);

    expect(
      certificateHashDataEquals(hash, {
        hashAlgorithm: hash.hashAlgorithm,
        issuerNameHash: hash.issuerNameHash.toUpperCase(),
        issuerKeyHash: hash.issuerKeyHash.toUpperCase(),
        serialNumber: hash.serialNumber.toUpperCase(),
      }),
    ).toBe(true);
  });

  it("returns false when any field differs", async () => {
    const { pem } = await selfSignedRootCert("0b", "Mismatch Test");
    const hash = await computeCertificateHashData(pem);

    expect(
      certificateHashDataEquals(hash, {
        ...hash,
        serialNumber: "ffffff",
      }),
    ).toBe(false);
  });
});
