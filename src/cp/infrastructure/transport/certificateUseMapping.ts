import type {
  CertificateSignedRequestV201,
  CertificateSignedRequestV21,
  GetInstalledCertificateIdsRequestV201,
  GetInstalledCertificateIdsRequestV21,
  InstallCertificateRequestV16,
  InstallCertificateRequestV201,
  InstallCertificateRequestV21,
} from "../../../ocpp";
import type {
  InstalledCertificateQuery,
  RootCertificateUse,
  SignedCertificateUse,
} from "../../domain/security/certificateUse";

/**
 * Explicit wire ↔ domain mapping of certificate uses per OCPP version
 * (#456). Each table is typed `Record<wire value, domain value>`, so a value
 * added to or removed from a generated wire enum fails the type check
 * here. Inbound functions take any string and return `undefined` for a
 * value the version does not define; outbound functions return `undefined`
 * for a domain use the version has no name for.
 */

type V16RootUse = InstallCertificateRequestV16["certificateType"];
type V201RootUse = InstallCertificateRequestV201["certificateType"];
type V21RootUse = InstallCertificateRequestV21["certificateType"];
type V201QueryUse = NonNullable<
  GetInstalledCertificateIdsRequestV201["certificateType"]
>[number];
type V21QueryUse = NonNullable<
  GetInstalledCertificateIdsRequestV21["certificateType"]
>[number];
type V201SignedUse = NonNullable<
  CertificateSignedRequestV201["certificateType"]
>;
type V21SignedUse = NonNullable<CertificateSignedRequestV21["certificateType"]>;

const V16_ROOT: Record<V16RootUse, RootCertificateUse> = {
  CentralSystemRootCertificate: "CsmsRootCertificate",
  ManufacturerRootCertificate: "ManufacturerRootCertificate",
};

const V201_ROOT: Record<V201RootUse, RootCertificateUse> = {
  CSMSRootCertificate: "CsmsRootCertificate",
  ManufacturerRootCertificate: "ManufacturerRootCertificate",
  V2GRootCertificate: "V2GRootCertificate",
  MORootCertificate: "MORootCertificate",
};

const V21_ROOT: Record<V21RootUse, RootCertificateUse> = {
  ...V201_ROOT,
  OEMRootCertificate: "OEMRootCertificate",
};

const V201_QUERY: Record<V201QueryUse, InstalledCertificateQuery> = {
  ...V201_ROOT,
  V2GCertificateChain: "V2GCertificateChain",
};

const V21_QUERY: Record<V21QueryUse, InstalledCertificateQuery> = {
  ...V21_ROOT,
  V2GCertificateChain: "V2GCertificateChain",
};

const V201_SIGNED: Record<V201SignedUse, SignedCertificateUse> = {
  ChargingStationCertificate: "ChargingStationCertificate",
  V2GCertificate: "V2GCertificate",
};

const V21_SIGNED: Record<V21SignedUse, SignedCertificateUse> = {
  ...V201_SIGNED,
  V2G20Certificate: "V2G20Certificate",
};

function inbound<W extends string, D>(
  table: Record<W, D>,
  value: string,
): D | undefined {
  return Object.prototype.hasOwnProperty.call(table, value)
    ? table[value as W]
    : undefined;
}

function outbound<W extends string, D>(
  table: Record<W, D>,
  use: D,
): W | undefined {
  return (Object.keys(table) as W[]).find((wire) => table[wire] === use);
}

// ── OCPP 1.6 Security Whitepaper ──────────────────────────────────────────

export const rootUseFromV16 = (value: string) => inbound(V16_ROOT, value);
export const rootUseToV16 = (use: RootCertificateUse) =>
  outbound(V16_ROOT, use);

// ── OCPP 2.0.1 ────────────────────────────────────────────────────────────

export const rootUseFromV201 = (value: string) => inbound(V201_ROOT, value);
export const rootUseToV201 = (use: RootCertificateUse) =>
  outbound(V201_ROOT, use);
export const installedCertificateQueryFromV201 = (value: string) =>
  inbound(V201_QUERY, value);
export const installedCertificateQueryToV201 = (
  query: InstalledCertificateQuery,
) => outbound(V201_QUERY, query);
export const signedUseFromV201 = (value: string) => inbound(V201_SIGNED, value);
export const signedUseToV201 = (use: SignedCertificateUse) =>
  outbound(V201_SIGNED, use);

// ── OCPP 2.1 ──────────────────────────────────────────────────────────────

export const rootUseFromV21 = (value: string) => inbound(V21_ROOT, value);
export const rootUseToV21 = (use: RootCertificateUse) =>
  outbound(V21_ROOT, use);
export const installedCertificateQueryFromV21 = (value: string) =>
  inbound(V21_QUERY, value);
export const installedCertificateQueryToV21 = (
  query: InstalledCertificateQuery,
) => outbound(V21_QUERY, query);
export const signedUseFromV21 = (value: string) => inbound(V21_SIGNED, value);
export const signedUseToV21 = (use: SignedCertificateUse) =>
  outbound(V21_SIGNED, use);
