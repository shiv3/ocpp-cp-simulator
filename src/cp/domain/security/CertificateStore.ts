import { generateCsr } from "./csr";

export type RootCertificateType =
  | "CentralSystemRootCertificate"
  | "ManufacturerRootCertificate";

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
