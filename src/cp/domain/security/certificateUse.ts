/**
 * Version-neutral certificate uses (#456). The domain keeps the superset of
 * what OCPP 1.6 Security Whitepaper, 2.0.1 and 2.1 define; each wire enum is
 * mapped onto these explicitly by the transport adapters
 * (`infrastructure/transport/certificateUseMapping.ts`), which also refuse
 * the values a version does not define. Nothing here is a wire string.
 */

/**
 * Trust anchors installed through InstallCertificate (M05).
 *
 * - `CsmsRootCertificate`: 1.6 `CentralSystemRootCertificate`, 2.x
 *   `CSMSRootCertificate`.
 * - `ManufacturerRootCertificate`: every version.
 * - `V2GRootCertificate`, `MORootCertificate`: 2.0.1 and 2.1.
 * - `OEMRootCertificate`: 2.1 only.
 */
export const ROOT_CERTIFICATE_USES = [
  "CsmsRootCertificate",
  "ManufacturerRootCertificate",
  "V2GRootCertificate",
  "MORootCertificate",
  "OEMRootCertificate",
] as const;

export type RootCertificateUse = (typeof ROOT_CERTIFICATE_USES)[number];

/**
 * Certificates the station signs a CSR for and receives back through
 * CertificateSigned (A02 / A03).
 *
 * - `ChargingStationCertificate`: every version (1.6 has a single,
 *   implicit use).
 * - `V2GCertificate`: 2.0.1 and 2.1.
 * - `V2G20Certificate`: 2.1 only.
 */
export const SIGNED_CERTIFICATE_USES = [
  "ChargingStationCertificate",
  "V2GCertificate",
  "V2G20Certificate",
] as const;

export type SignedCertificateUse = (typeof SIGNED_CERTIFICATE_USES)[number];

/** The station's V2G certificates: the chains a 2.1 `V2GCertificateChain`
 *  query lists (M03.FR.05) and whose OCSP status the station caches
 *  (M06.FR.06, #537). 2.0.1 never stores a `V2G20Certificate`. */
export const V2G_CERTIFICATE_USES: readonly SignedCertificateUse[] = [
  "V2GCertificate",
  "V2G20Certificate",
];

/**
 * What GetInstalledCertificateIds can ask for: a trust anchor use, or the
 * station's V2G certificate chain (2.x `V2GCertificateChain`, M03.FR.05),
 * which is a query over the stored `V2GCertificate` chains, not something
 * InstallCertificate can install.
 */
export type InstalledCertificateQuery =
  RootCertificateUse | "V2GCertificateChain";

export function isRootCertificateUse(
  value: unknown,
): value is RootCertificateUse {
  return (ROOT_CERTIFICATE_USES as readonly unknown[]).includes(value);
}

export function isSignedCertificateUse(
  value: unknown,
): value is SignedCertificateUse {
  return (SIGNED_CERTIFICATE_USES as readonly unknown[]).includes(value);
}
