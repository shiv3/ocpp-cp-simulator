import "reflect-metadata";
import * as x509 from "@peculiar/x509";

import { CERTIFICATE_PEM_RE } from "./certificateHash";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

/** Why a firmware signing certificate is refused. */
export type SigningCertificateProblem =
  "Unparsable" | "NotYetValid" | "Expired" | "UntrustedIssuer";

export type SigningCertificateCheck =
  | { ok: true }
  | { ok: false; problem: SigningCertificateProblem; detail: string };

/**
 * Checks the `signingCertificate` of an OCPP 1.6 SignedUpdateFirmware
 * (security whitepaper L01.FR.23) or a 2.x UpdateFirmware (L01.FR.21): it must
 * parse as an X.509 certificate and `now` must lie inside its validity
 * period. When the station holds ManufacturerRootCertificates, the
 * certificate must also name one of them as its issuer (the issuer
 * check); without an installed root there is nothing to anchor to and the
 * check stops at the validity period. The check is synchronous because a
 * default behavior answers synchronously, and WebCrypto verifies a
 * signature asynchronously only: the issuer is matched by subject name and,
 * when both certificates carry them, by Authority / Subject Key Identifier,
 * not by verifying the issuer's signature. The firmware signature itself is
 * not checked either: the simulator has no binary.
 */
export function checkFirmwareSigningCertificate(
  pem: unknown,
  now: Date,
  manufacturerRoots: readonly string[] = [],
): SigningCertificateCheck {
  const first =
    typeof pem === "string" ? pem.match(CERTIFICATE_PEM_RE)?.[0] : undefined;
  let cert: x509.X509Certificate;
  try {
    if (!first) throw new Error("no PEM certificate");
    cert = new x509.X509Certificate(first.trim());
  } catch {
    return {
      ok: false,
      problem: "Unparsable",
      detail: "the signingCertificate is not a parsable PEM X.509 certificate",
    };
  }
  if (now < cert.notBefore) {
    return {
      ok: false,
      problem: "NotYetValid",
      detail: `the signingCertificate is valid from ${cert.notBefore.toISOString()}`,
    };
  }
  if (now > cert.notAfter) {
    return {
      ok: false,
      problem: "Expired",
      detail: `the signingCertificate expired at ${cert.notAfter.toISOString()}`,
    };
  }
  if (manufacturerRoots.length > 0) {
    for (const rootPem of manufacturerRoots) {
      try {
        const root = new x509.X509Certificate(rootPem);
        if (root.subject === cert.issuer && keyIdsAgree(cert, root)) {
          return { ok: true };
        }
      } catch {
        // An unusable root cannot vouch for the certificate.
      }
    }
    return {
      ok: false,
      problem: "UntrustedIssuer",
      detail:
        "the signingCertificate is not signed by an installed ManufacturerRootCertificate",
    };
  }
  return { ok: true };
}

/** The certificate's Authority Key Identifier equals the root's Subject Key
 *  Identifier; true when either extension is absent. */
function keyIdsAgree(cert: x509.X509Certificate, root: x509.X509Certificate) {
  const authority = cert.getExtension(x509.AuthorityKeyIdentifierExtension);
  const subject = root.getExtension(x509.SubjectKeyIdentifierExtension);
  if (!authority?.keyId || !subject) return true;
  return authority.keyId.toLowerCase() === subject.keyId.toLowerCase();
}
