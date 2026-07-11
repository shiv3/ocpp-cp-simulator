import { generateCsr } from "./csr";

export type RootCertificateType =
  "CentralSystemRootCertificate" | "ManufacturerRootCertificate";

export interface InstalledRootCertificate {
  type: RootCertificateType;
  pem: string;
}

export interface CertificateStoreJson {
  pendingCsrPem?: string;
  signedChains: string[][];
  rootCerts: InstalledRootCertificate[];
}

export class CertificateStore {
  // Holds the CSR's generated private key so it can be paired with the signed
  // certificate; written at CSR time and cleared on reset, not read back yet.
  // eslint-disable-next-line no-unused-private-class-members
  #keyPair: CryptoKeyPair | undefined;
  #pendingCsrPem: string | undefined;
  #signedChains: string[][] = [];
  #rootCerts: InstalledRootCertificate[] = [];

  async generateNewCsr(serial: string, cpoName: string): Promise<string> {
    const generated = await generateCsr(serial, cpoName);

    this.#keyPair = {
      privateKey: generated.privateKey,
      publicKey: generated.publicKey,
    };
    this.#pendingCsrPem = generated.pem;

    return generated.pem;
  }

  storeSignedChain(pemChain: string[]): void {
    this.#signedChains.push([...pemChain]);
  }

  installRootCert(type: RootCertificateType, pem: string): void {
    this.#rootCerts.push({ type, pem });
  }

  listRootCerts(): InstalledRootCertificate[] {
    return this.#rootCerts.map((cert) => ({ ...cert }));
  }

  /**
   * Removes the first stored root certificate matching `predicate`
   * (DeleteCertificate.req matches by `certificateHashData`, computed by
   * the caller via `certificateHash.ts` — this store stays decoupled from
   * the hashing/crypto concern). Returns `true` when a certificate was
   * removed, `false` when nothing matched.
   */
  deleteRootCert(
    predicate: (cert: InstalledRootCertificate) => boolean,
  ): boolean {
    const index = this.#rootCerts.findIndex(predicate);
    if (index === -1) return false;
    this.#rootCerts.splice(index, 1);
    return true;
  }

  clearAll(): void {
    this.#keyPair = undefined;
    this.#pendingCsrPem = undefined;
    this.#signedChains = [];
    this.#rootCerts = [];
  }

  toJSON(): CertificateStoreJson {
    return {
      ...(this.#pendingCsrPem ? { pendingCsrPem: this.#pendingCsrPem } : {}),
      signedChains: this.#signedChains.map((chain) => [...chain]),
      rootCerts: this.listRootCerts(),
    };
  }

  toString(): string {
    return JSON.stringify(this.toJSON());
  }
}
