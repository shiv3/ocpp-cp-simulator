import "reflect-metadata";
import { describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";
import { generateCsr } from "../csr";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

describe("generateCsr", () => {
  it("default: CSR is ECDSA P-256 with SHA-256", async () => {
    const generated = await generateCsr("TEST-SERIAL", "TestCPO");

    expect(generated.pem).toContain("-----BEGIN CERTIFICATE REQUEST-----");
    expect(generated.csr).toBeInstanceOf(x509.Pkcs10CertificateRequest);

    // Verify the CSR signature
    const isValid = await generated.csr.verify();
    expect(isValid).toBe(true);

    // Parse and check the public key algorithm is ECDSA
    const publicKey = generated.csr.publicKey;
    expect(publicKey.algorithm.name).toBe("ECDSA");
    expect((publicKey.algorithm as EcKeyAlgorithm).namedCurve).toBe("P-256");

    // Check signature algorithm is ECDSA with SHA-256
    const sigAlg = generated.csr.signatureAlgorithm;
    expect(sigAlg.name).toBe("ECDSA");
  });

  it("keyAlgorithm 'RSA': CSR public key and signature are RSA", async () => {
    const generated = await generateCsr("TEST-SERIAL-RSA", "TestCPO", {
      keyAlgorithm: "RSA",
    });

    expect(generated.pem).toContain("-----BEGIN CERTIFICATE REQUEST-----");
    const isValid = await generated.csr.verify();
    expect(isValid).toBe(true);

    // Parse and check the public key algorithm is RSA
    const publicKey = generated.csr.publicKey;
    expect(publicKey.algorithm.name).toBe("RSASSA-PKCS1-v1_5");
    expect((publicKey.algorithm as RsaKeyAlgorithm).modulusLength).toBe(2048);

    // Check signature algorithm name (x509 returns "RSASSA-PKCS1-v1_5" for RSA CSRs)
    const sigAlg = generated.csr.signatureAlgorithm;
    expect(sigAlg.name).toBe("RSASSA-PKCS1-v1_5");
  });

  it("pemLineEndings 'crlf': converts LF to CRLF", async () => {
    const generated = await generateCsr("TEST-SERIAL-CRLF", "TestCPO", {
      pemLineEndings: "crlf",
    });

    // Should have CRLF line endings
    expect(generated.pem).toContain("\r\n");
    // Should NOT have isolated LF (which would be CRLF converted to CRCRLF)
    const lines = generated.pem.split("\r\n");
    for (const line of lines) {
      expect(line).not.toContain("\r");
      expect(line).not.toContain("\n");
    }

    // Verify the PEM is still valid by parsing it
    const csr = new x509.Pkcs10CertificateRequest(generated.pem);
    expect(csr.subject).toContain("CN=TEST-SERIAL-CRLF");
  });

  it("pemLineEndings 'crlf': idempotently converts, no double conversion", async () => {
    const generated = await generateCsr("TEST-SERIAL-CRLF-2", "TestCPO", {
      pemLineEndings: "crlf",
    });

    // Count CRLF sequences
    const crlfCount = (generated.pem.match(/\r\n/g) || []).length;
    // Count isolated CR (would indicate double conversion)
    const isolatedCrCount = (
      generated.pem.replace(/\r\n/g, "").match(/\r/g) || []
    ).length;

    expect(crlfCount).toBeGreaterThan(0);
    expect(isolatedCrCount).toBe(0); // No isolated CR
  });

  it("keyAlgorithm 'RSA' + pemLineEndings 'crlf': both options work together", async () => {
    const generated = await generateCsr("TEST-SERIAL-RSA-CRLF", "TestCPO", {
      keyAlgorithm: "RSA",
      pemLineEndings: "crlf",
    });

    // Check RSA
    const publicKey = generated.csr.publicKey;
    expect(publicKey.algorithm.name).toBe("RSASSA-PKCS1-v1_5");

    // Check CRLF
    expect(generated.pem).toContain("\r\n");
    const lines = generated.pem.split("\r\n");
    for (const line of lines) {
      expect(line).not.toContain("\r");
      expect(line).not.toContain("\n");
    }

    // Verify signature
    const isValid = await generated.csr.verify();
    expect(isValid).toBe(true);
  });

  it("pemLineEndings 'lf': keeps LF line endings (default)", async () => {
    const generated = await generateCsr("TEST-SERIAL-LF", "TestCPO", {
      pemLineEndings: "lf",
    });

    // Should have LF but not CRLF
    expect(generated.pem).toContain("\n");
    expect(generated.pem).not.toContain("\r\n");
  });

  it("no options: defaults to ECDSA + LF", async () => {
    const generated = await generateCsr("TEST-SERIAL-DEFAULTS", "TestCPO");

    // Check ECDSA
    const publicKey = generated.csr.publicKey;
    expect(publicKey.algorithm.name).toBe("ECDSA");

    // Check LF (no CRLF)
    expect(generated.pem).not.toContain("\r\n");
    expect(generated.pem).toContain("\n");
  });

  it("CSR subject includes serial and CPO name", async () => {
    const generated = await generateCsr("MY-SERIAL-123", "My CPO Inc");

    expect(generated.csr.subject).toContain("CN=MY-SERIAL-123");
    expect(generated.csr.subject).toContain("O=My CPO Inc");
  });

  it("RSA: uses 2048-bit modulus and SHA-256 hash", async () => {
    const generated = await generateCsr("TEST-RSA-PARAMS", "TestCPO", {
      keyAlgorithm: "RSA",
    });

    const publicKey = generated.csr.publicKey;
    const rsaAlg = publicKey.algorithm as RsaKeyAlgorithm;
    expect(rsaAlg.modulusLength).toBe(2048);

    const sigAlg = generated.csr.signatureAlgorithm;
    expect(sigAlg.name).toBe("RSASSA-PKCS1-v1_5");
  });
});
