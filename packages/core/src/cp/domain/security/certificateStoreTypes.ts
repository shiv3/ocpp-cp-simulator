// The value types of the CertificateStore, split out of CertificateStore.ts
// (#877).
import type { CertificateHashData } from "./certificateHash";
import type {
  InstalledCertificateQuery,
  RootCertificateUse,
  SignedCertificateUse,
} from "./certificateUse";

/** Hash data as a CSMS sends it: any algorithm name, any hex casing. */
export interface CertificateHashDataLike {
  hashAlgorithm: string;
  issuerNameHash: string;
  issuerKeyHash: string;
  serialNumber: string;
}

/** A trust anchor installed through InstallCertificate (M05). */
export interface InstalledRootCertificate {
  readonly use: RootCertificateUse;
  /** Trimmed PEM, as received. */
  readonly pem: string;
  /** Computed once at install time, so lookups stay synchronous. */
  readonly hashData: CertificateHashData;
  readonly installedAt: string;
}

/** A certificate chain received through CertificateSigned (A02 / A03). */
export interface StoredCertificateChain {
  readonly use: SignedCertificateUse;
  /** Leaf first, then its sub-CAs, each trimmed. */
  readonly pems: readonly string[];
  /** One entry per `pems` element, hashed against that element's issuer. */
  readonly hashData: readonly CertificateHashData[];
  readonly storedAt: string;
}

/** One GetInstalledCertificateIds entry, version-neutral (M03). */
export interface InstalledCertificateIds {
  readonly use: InstalledCertificateQuery;
  readonly hashData: CertificateHashData;
  /** Sub-CA hash data under a V2G leaf (M03.FR.05); empty for roots. */
  readonly childHashData: readonly CertificateHashData[];
}

export type InstallRootCertificateOutcome =
  | { status: "Installed"; certificate: InstalledRootCertificate }
  | { status: "Malformed" }
  | { status: "StoreFull"; limit: number }
  /** The database refused the row; nothing was installed. */
  | { status: "PersistFailed" };

export interface InstallRootCertificateOptions {
  /** Roots the store may hold (signed chains do not count). */
  maxEntries: number;
  /**
   * Replace an installed root with the same hash data instead of adding a
   * second copy (2.x M05.FR.17). The replaced root does not count against
   * `maxEntries`. Off by default: 1.6 keeps duplicates.
   */
  replaceDuplicate?: boolean;
}

export type DeleteCertificateOutcome =
  | { status: "Deleted"; use: RootCertificateUse | SignedCertificateUse }
  | { status: "NotFound" }
  /** M04.FR.06 (2.x) / M04.FR.05 (1.6 whitepaper): never deletable. */
  | { status: "ChargingStationCertificate" };

/** An OCSP response cached for one certificate (2.x M06, #537). */
export interface CachedOcspResponse {
  /** Base64 DER OCSPResponse, as the CSMS sent it. */
  readonly ocspResult: string;
  readonly cachedAt: string;
}

export type ApplySignedChainOutcome =
  | { status: "Accepted"; chain: StoredCertificateChain }
  | { status: "Malformed" }
  | { status: "NoPendingCsr" }
  | { status: "PublicKeyMismatch" }
  /** A chain member's `notAfter` has passed (A02.FR.06, #587); `reason`
   *  names the member. */
  | { status: "Expired"; reason: string }
  /** A chain member's `notBefore` is in the future (2.0.1 and 2.1
   *  A02.FR.06, #587). */
  | { status: "NotYetValid"; reason: string }
  /** The key or subject breaks the Certificate Properties (A02.FR.06,
   *  A00.FR.501-511, #587). */
  | { status: "InvalidProperties"; reason: string }
  /** The chain is not part of the operator hierarchy (A02.FR.06, #587). */
  | { status: "OutsideHierarchy"; reason: string };

/**
 * Safe snapshot of the store. Holds public material only (certificates and
 * CSRs): the private keys the store holds in memory (#537) are left out.
 */
export interface CertificateStoreJson {
  pendingCsrs: { use: SignedCertificateUse; pem: string }[];
  rootCerts: InstalledRootCertificate[];
  /** PEMs of each stored chain, leaf first (kept for the 1.6 tests). */
  signedChains: string[][];
}

/** A signed Charging Station certificate the station can present as its
 *  TLS client identity (#537, A02.FR.08). */
export interface TlsClientIdentity {
  /** The stored chain, leaf first, as PEM. */
  readonly cert: string;
  /** The leaf's PKCS#8 private key, as PEM. */
  readonly key: string;
  /** The leaf's `notBefore`: the station switches once it has passed. */
  readonly notBefore: Date;
}
