import "reflect-metadata";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

import type { SignedCertificateUse } from "./certificateUse";

/**
 * Checks of A02.FR.06 beyond the leaf's validity period (#587): the
 * Certificate Properties (2.0.1 / 2.1 A00.FR.501-503, A00.FR.508, A00.FR.509,
 * A00.FR.511) and membership of the operator certificate hierarchy (Certificate
 * Hierarchy, A00.FR.6xx). Only the SHALL rules are enforced; the SHOULD rules
 * (signature algorithm, hash, Key Usage) are not.
 */

export type ChainCheckFailure =
  | { status: "Expired"; reason: string }
  | { status: "NotYetValid"; reason: string }
  | { status: "InvalidProperties"; reason: string }
  | { status: "OutsideHierarchy"; reason: string };

/** The smallest key the Certificate Properties allow (A00.FR.501-503). */
const MIN_RSA_BITS = 2048;
const MIN_EC_BITS = 224;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function looksLikeUrlOrIp(value: string): boolean {
  return value.includes("://") || IPV4.test(value) || value.includes(":");
}

/** The first problem of the key and subject of one certificate, if any. */
function propertyProblem(
  cert: x509.X509Certificate,
  position: string,
  leafUse: SignedCertificateUse | undefined,
): string | undefined {
  const algorithm = cert.publicKey.algorithm as {
    name: string;
    modulusLength?: number;
    namedCurve?: string;
  };
  if (algorithm.modulusLength !== undefined) {
    if (algorithm.modulusLength < MIN_RSA_BITS) {
      return `${position}: ${algorithm.name} key of ${algorithm.modulusLength} bits, below ${MIN_RSA_BITS} (A00.FR.502)`;
    }
  } else if (algorithm.namedCurve !== undefined) {
    const bits = Number(/(\d+)/.exec(algorithm.namedCurve)?.[1]);
    if (!Number.isFinite(bits) || bits < MIN_EC_BITS) {
      return `${position}: elliptic curve ${algorithm.namedCurve} below ${MIN_EC_BITS} bits (A00.FR.503)`;
    }
  }
  if (!cert.serialNumber) return `${position}: no serial number (A00.FR.508)`;
  if (cert.subjectName.getField("O").length === 0) {
    return `${position}: subject has no organization (O) RDN (A00.FR.509)`;
  }
  if (leafUse === "ChargingStationCertificate") {
    const cn = cert.subjectName.getField("CN")[0];
    if (!cn) return `${position}: subject has no commonName (A00.FR.511)`;
    if (looksLikeUrlOrIp(cn)) {
      return `${position}: commonName is a URL or an IP address (A00.FR.511)`;
    }
  }
  return undefined;
}

export interface ChainCheckInput {
  readonly use: SignedCertificateUse;
  readonly chain: readonly x509.X509Certificate[];
  /** Installed roots of the hierarchy the use belongs to. */
  readonly anchors: readonly x509.X509Certificate[];
  readonly now: number;
}

/**
 * Validity of every chain member, Certificate Properties (key, serial and O of every member, the CN rule of the leaf), and
 * the hierarchy. The leaf's own validity is reported first so the outcome
 * names the certificate the CSMS most likely meant.
 *
 * Hierarchy: each member must be signed by the next one; the last member
 * must be an installed root or signed by one. With no root of the hierarchy
 * installed the station cannot tell which operator hierarchy it belongs to:
 * only the internal links are checked then.
 */
export async function checkSignedChain({
  use,
  chain,
  anchors,
  now,
}: ChainCheckInput): Promise<ChainCheckFailure | undefined> {
  for (const [i, cert] of chain.entries()) {
    const label = i === 0 ? "leaf" : `chain member ${i}`;
    if (now >= cert.notAfter.getTime()) {
      return { status: "Expired", reason: `the ${label} has expired` };
    }
    if (now < cert.notBefore.getTime()) {
      return {
        status: "NotYetValid",
        reason: `the ${label} is not valid yet`,
      };
    }
  }
  for (const [i, cert] of chain.entries()) {
    const problem = propertyProblem(
      cert,
      i === 0 ? "leaf" : `chain member ${i}`,
      i === 0 ? use : undefined,
    );
    if (problem) return { status: "InvalidProperties", reason: problem };
  }
  for (let i = 0; i + 1 < chain.length; i++) {
    if (!(await signedBy(chain[i], chain[i + 1]))) {
      return {
        status: "OutsideHierarchy",
        reason: `chain member ${i} is not signed by member ${i + 1}`,
      };
    }
  }
  if (anchors.length > 0) {
    const top = chain[chain.length - 1];
    const anchored =
      anchors.some((root) => root.equal(top)) ||
      (await anyAnchorSigns(anchors, top));
    if (!anchored) {
      return {
        status: "OutsideHierarchy",
        reason: "the chain does not lead to an installed root certificate",
      };
    }
  }
  return undefined;
}

async function anyAnchorSigns(
  anchors: readonly x509.X509Certificate[],
  cert: x509.X509Certificate,
): Promise<boolean> {
  for (const root of anchors) {
    if (await signedBy(cert, root)) return true;
  }
  return false;
}

async function signedBy(
  cert: x509.X509Certificate,
  issuer: x509.X509Certificate,
): Promise<boolean> {
  if (cert.issuer !== issuer.subject) return false;
  try {
    return await cert.verify({
      publicKey: issuer.publicKey,
      signatureOnly: true,
    });
  } catch {
    return false;
  }
}
