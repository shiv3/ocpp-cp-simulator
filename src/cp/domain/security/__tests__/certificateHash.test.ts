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

/**
 * Fixed known-answer fixture, generated and hashed entirely OUTSIDE the
 * library under test (OpenSSL 3.6.2):
 *
 *   openssl ecparam -name prime256v1 -genkey -noout -out key.pem
 *   openssl req -new -x509 -key key.pem -days 7300 -sha256 \
 *     -subj "/CN=OCPP KAT Root CA/O=Example CPO" -set_serial 0x0aa2b3
 *
 * Expected hashes derived from the DER via `openssl asn1parse` offsets and
 * `openssl dgst -sha256`: issuerNameHash over the issuer Name SEQUENCE
 * (51 bytes at offset 30); issuerKeyHash over the subjectPublicKey BIT
 * STRING content minus the leading unused-bits octet (65 bytes at offset
 * 190 — the 0x04-prefixed uncompressed EC point).
 */
const KAT_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBpjCCAUygAwIBAgIDCqKzMAoGCCqGSM49BAMCMDExGTAXBgNVBAMMEE9DUFAg
S0FUIFJvb3QgQ0ExFDASBgNVBAoMC0V4YW1wbGUgQ1BPMB4XDTI2MDcwNzExNDQw
NloXDTQ2MDcwMjExNDQwNlowMTEZMBcGA1UEAwwQT0NQUCBLQVQgUm9vdCBDQTEU
MBIGA1UECgwLRXhhbXBsZSBDUE8wWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATF
sHwsmYjqvegLgl3oDlAHvalUN6+rj99NXr2TgkSFzfIe7fBNb2fzLeV8zLFXJ7if
z5JXpaljzbIaVkr9N5FIo1MwUTAdBgNVHQ4EFgQU2hS5MJMuHrIOcgETuqpDbQkC
2gUwHwYDVR0jBBgwFoAU2hS5MJMuHrIOcgETuqpDbQkC2gUwDwYDVR0TAQH/BAUw
AwEB/zAKBggqhkjOPQQDAgNIADBFAiEAgNy7JC9GKPvwAr0H18p/x78OAlUHPeg9
8UGq9LUH7SQCICG3tEVQJC6tLIZOar+KzwF3dGbOHRk6kK4tuI+pq1kw
-----END CERTIFICATE-----`;

describe("computeCertificateHashData", () => {
  it("matches OpenSSL-derived known-answer hashes for a fixed certificate", async () => {
    const result = await computeCertificateHashData(KAT_CERT_PEM);

    expect(result).toEqual({
      hashAlgorithm: "SHA256",
      issuerNameHash:
        "2f1e564ddbf440fc551bf9d5284e6700c64a42fb685d5c9db91f606a721c0fa4",
      issuerKeyHash:
        "e5330c333975c58e5d299572140e2663337dfc1714ea5c85f581151b5eae8059",
      serialNumber: "0aa2b3",
    });
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
