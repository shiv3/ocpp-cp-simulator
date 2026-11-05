import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import * as x509 from "@peculiar/x509";

import { CertificateStore } from "./CertificateStore";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

describe("CertificateStore", () => {
  it("generates a parseable and verifiable P-256 CSR", async () => {
    const store = new CertificateStore();
    const serial = "CP-A4-001";
    const cpoName = "Example CPO";

    const pem = await store.generateNewCsr(serial, cpoName);

    expect(pem.startsWith("-----BEGIN CERTIFICATE REQUEST-----")).toBe(true);

    const csr = new x509.Pkcs10CertificateRequest(pem);
    expect(csr.subject).toContain(`CN=${serial}`);
    expect(csr.subject).toContain(`O=${cpoName}`);
    expect(await csr.verify()).toBe(true);
  });

  it("does not expose private key material through public access or JSON", async () => {
    const store = new CertificateStore();
    await store.generateNewCsr("CP-A4-SECRET", "Example CPO");

    const externallyVisible = store as unknown as {
      getPrivateKey?: unknown;
      privateKey?: unknown;
      key?: unknown;
    };

    expect(externallyVisible.getPrivateKey).toBeUndefined();
    expect(externallyVisible.privateKey).toBeUndefined();
    expect(externallyVisible.key).toBeUndefined();

    const json = JSON.stringify(store);
    expect(json).not.toMatch(/"privateKey"\s*:/i);
    expect(json).not.toMatch(/"key"\s*:\s*"[^"]{8,}"/i);
  });
});
