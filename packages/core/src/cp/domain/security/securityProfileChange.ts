import "reflect-metadata";
import * as x509 from "@peculiar/x509";

import { CERTIFICATE_PEM_RE } from "./certificateHash";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

/** What a ChangeConfiguration of `SecurityProfile` is checked against. */
export interface SecurityProfileChangeInput {
  readonly current: number;
  readonly next: number;
  /** The stored `AuthorizationKey`. */
  readonly authorizationKey: string;
  /** A currently valid CentralSystemRootCertificate is available. */
  readonly hasCentralSystemRoot: boolean;
  /** A currently valid ChargePointCertificate is available. */
  readonly hasChargePointCertificate: boolean;
}

export type SecurityProfileChangeVerdict =
  | { readonly allowed: true; readonly upgrade: boolean }
  | {
      readonly allowed: false;
      readonly requirement:
        "A00.FR.005" | "A05.FR.01" | "A05.FR.02" | "A05.FR.03" | "A05.FR.04";
      readonly reason: string;
    };

/**
 * Security whitepaper §7.2: the AuthorizationKey is at least 16 bytes and, in
 * its hexadecimal form, at most 20 bytes (40 hex digits). The simulator takes
 * both shapes the connection code derives a Basic password from
 * (`authorizationKeyToBasicPassword`): 32 to 40 hex digits (16-20 bytes), or
 * a plain key of 16 to 20 printable ASCII characters (#839; the lengths do not
 * overlap).
 */
export function isValidAuthorizationKey(value: string): boolean {
  return (
    /^(?:[0-9a-fA-F]{2}){16,20}$/.test(value) ||
    /^[\x21-\x7e]{16,20}$/.test(value)
  );
}

/**
 * The checks of whitepaper ed.4 for a ChangeConfiguration of
 * `SecurityProfile`. A05.FR.01 refuses a value greater than 1 and lower than
 * or equal to the current one, and A00.FR.005 / §7.8 refuse any other
 * lowering (only 3 → 2 may be allowed, by `AllowSecurityProfileDowngrade`,
 * which is not implemented). A value of 0 or 1 equal to the current one is
 * covered by neither: nothing changes and it is allowed. A05.FR.02-04 refuse an
 * upgrade whose prerequisites are missing; an allowed upgrade is A05.FR.05.
 */
export function checkSecurityProfileChange(
  input: SecurityProfileChangeInput,
): SecurityProfileChangeVerdict {
  const { current, next } = input;
  if (next > 1 && next <= current) {
    return {
      allowed: false,
      requirement: "A05.FR.01",
      reason: `security profile ${current} cannot be changed to ${next}: downgrades are not allowed (AllowSecurityProfileDowngrade is not implemented)`,
    };
  }
  if (next < current) {
    return {
      allowed: false,
      requirement: "A00.FR.005",
      reason: `security profile ${current} cannot be changed to ${next}: lowering the profile to ${next} is never allowed over OCPP`,
    };
  }
  if (next === current) return { allowed: true, upgrade: false };
  if (
    (next === 1 || next === 2) &&
    !isValidAuthorizationKey(input.authorizationKey)
  ) {
    return {
      allowed: false,
      requirement: "A05.FR.02",
      reason: `security profile ${next} needs an AuthorizationKey of 16-20 bytes (32-40 hex digits)`,
    };
  }
  if ((next === 2 || next === 3) && !input.hasCentralSystemRoot) {
    return {
      allowed: false,
      requirement: "A05.FR.03",
      reason: `security profile ${next} needs a valid CentralSystemRootCertificate`,
    };
  }
  if (next === 3 && !input.hasChargePointCertificate) {
    return {
      allowed: false,
      requirement: "A05.FR.04",
      reason: "security profile 3 needs a valid ChargePointCertificate",
    };
  }
  return { allowed: true, upgrade: true };
}

/** Whether the first certificate of `pem` parses and `now` lies inside its
 *  validity period. */
export function isCertificateCurrentlyValid(pem: string, now: Date): boolean {
  const first = pem.match(CERTIFICATE_PEM_RE)?.[0];
  if (!first) return false;
  try {
    const cert = new x509.X509Certificate(first.trim());
    return now >= cert.notBefore && now <= cert.notAfter;
  } catch {
    return false;
  }
}
