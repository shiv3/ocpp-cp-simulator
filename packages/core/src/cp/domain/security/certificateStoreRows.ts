// Row decoding and small helpers of the CertificateStore, split out of
// CertificateStore.ts (#877).
import * as x509 from "@peculiar/x509";
import type { StoredCertificate } from "../persistence/CertificateRepository";
import {
  normalizeSerialNumber,
  type CertificateHashData,
} from "./certificateHash";
import {
  isRootCertificateUse,
  isSignedCertificateUse,
  type RootCertificateUse,
  type SignedCertificateUse,
} from "./certificateUse";
import type {
  InstalledRootCertificate,
  StoredCertificateChain,
} from "./certificateStoreTypes";

export type Entry =
  | { kind: "root"; seq: number; value: InstalledRootCertificate }
  | { kind: "chain"; seq: number; value: StoredCertificateChain };

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

/**
 * The subject of an installed root, or undefined when it no longer parses:
 * @peculiar/x509 2 accepted DER with trailing bytes, so a state database
 * written by an older release may hold a root that version 3 rejects. Such a
 * root never issues a chain member, and DeleteCertificate still removes it by
 * its stored hash data.
 */
/** The trust anchor of the hierarchy a signed certificate belongs to. */
export function hierarchyRootUse(
  use: SignedCertificateUse,
): RootCertificateUse {
  return use === "ChargingStationCertificate"
    ? "CsmsRootCertificate"
    : "V2GRootCertificate";
}

export function subjectOf(pem: string): string | undefined {
  try {
    return new x509.X509Certificate(pem).subject;
  } catch {
    return undefined;
  }
}

export function rowToEntry(row: StoredCertificate): Entry | null {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.body);
    if (typeof parsed !== "object" || parsed === null) return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (row.kind === "root" && isRootCertificateUse(row.use)) {
    if (typeof body.pem !== "string" || !isHashData(body.hashData)) return null;
    return {
      kind: "root",
      seq: row.seq,
      value: {
        use: row.use,
        pem: body.pem,
        hashData: normalizeHashData(body.hashData),
        installedAt: row.installedAt,
      },
    };
  }
  if (row.kind === "chain" && isSignedCertificateUse(row.use)) {
    const { pems, hashData } = body;
    if (
      !Array.isArray(pems) ||
      pems.length === 0 ||
      !pems.every((p) => typeof p === "string") ||
      !Array.isArray(hashData) ||
      hashData.length !== pems.length ||
      !hashData.every(isHashData)
    ) {
      return null;
    }
    return {
      kind: "chain",
      seq: row.seq,
      value: {
        use: row.use,
        pems: pems as string[],
        hashData: (hashData as CertificateHashData[]).map(normalizeHashData),
        storedAt: row.installedAt,
      },
    };
  }
  return null;
}

/**
 * Rows written before #537 hold the serialNumber with its leading zero;
 * they are read back in the current form, so GetInstalledCertificateIds
 * reports one form whatever the row's age.
 */
export function normalizeHashData(
  hash: CertificateHashData,
): CertificateHashData {
  return { ...hash, serialNumber: normalizeSerialNumber(hash.serialNumber) };
}

export function isHashData(value: unknown): value is CertificateHashData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.hashAlgorithm === "SHA256" &&
    typeof v.issuerNameHash === "string" &&
    typeof v.issuerKeyHash === "string" &&
    typeof v.serialNumber === "string"
  );
}
