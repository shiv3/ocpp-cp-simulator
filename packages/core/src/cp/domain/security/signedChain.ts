import "reflect-metadata";
import * as x509 from "@peculiar/x509";

import { bytesEqual } from "./certificateHash";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

export type SignedChainProblem =
  | "Malformed"
  | "NotYetValid"
  | "Expired"
  | "BrokenChain"
  | "UntrustedIssuer"
  | "PublicKeyMismatch";

export type SignedChainCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly problem: SignedChainProblem;
      readonly detail: string;
    };

export interface SignedChainContext {
  /** The time of the update (A02.FR.06). */
  readonly now: Date;
  /** Installed CSMS root certificates (PEM). With none, the issuer of the
   *  chain's top certificate cannot be anchored and is not checked. */
  readonly trustedRoots: readonly string[];
  /** The PKCS#10 request the station has pending, if any: the leaf must
   *  carry its public key. */
  readonly pendingCsr?: string;
}

/**
 * OCPP 1.6 security whitepaper ed.4 A02.FR.06: checks the signed Charge
 * Point certificate chain of a CertificateSigned (leaf first):
 *
 * - every certificate is inside its validity period at `now`;
 * - every certificate is signed by the next one (name and signature);
 * - when CSMS roots are installed, the top certificate is one of them or is
 *   signed by one (the Charge Point Operator hierarchy);
 * - the leaf carries the public key of the pending CSR.
 *
 * The Certificate Properties (key usage and the like) are not inspected.
 */
export async function checkSignedChain(
  pems: readonly string[],
  context: SignedChainContext,
): Promise<SignedChainCheck> {
  let chain: x509.X509Certificate[];
  try {
    chain = pems.map((pem) => new x509.X509Certificate(pem));
  } catch {
    return fail("Malformed", "a certificate of the chain does not parse");
  }
  if (chain.length === 0) return fail("Malformed", "the chain is empty");

  for (const cert of chain) {
    if (context.now < cert.notBefore) {
      return fail(
        "NotYetValid",
        `${cert.subject} is valid from ${cert.notBefore.toISOString()}`,
      );
    }
    if (context.now > cert.notAfter) {
      return fail(
        "Expired",
        `${cert.subject} expired at ${cert.notAfter.toISOString()}`,
      );
    }
  }

  for (let i = 0; i + 1 < chain.length; i++) {
    const issuer = chain[i + 1];
    if (
      chain[i].issuer !== issuer.subject ||
      !(await signedBy(chain[i], issuer))
    ) {
      return fail(
        "BrokenChain",
        `${chain[i].subject} is not signed by ${issuer.subject}`,
      );
    }
  }

  if (context.trustedRoots.length > 0) {
    const top = chain[chain.length - 1];
    let trusted = false;
    for (const rootPem of context.trustedRoots) {
      try {
        const root = new x509.X509Certificate(rootPem);
        if (
          bytesEqual(
            new Uint8Array(root.rawData),
            new Uint8Array(top.rawData),
          ) ||
          (root.subject === top.issuer && (await signedBy(top, root)))
        ) {
          trusted = true;
          break;
        }
      } catch {
        // An unusable root cannot vouch for the chain.
      }
    }
    if (!trusted) {
      return fail(
        "UntrustedIssuer",
        `${top.subject} is not part of the installed CSMS root hierarchy`,
      );
    }
  }

  if (context.pendingCsr) {
    try {
      const csr = new x509.Pkcs10CertificateRequest(context.pendingCsr);
      if (
        !bytesEqual(
          new Uint8Array(csr.publicKey.rawData),
          new Uint8Array(chain[0].publicKey.rawData),
        )
      ) {
        return fail(
          "PublicKeyMismatch",
          "the leaf does not match the pending CSR's public key",
        );
      }
    } catch {
      // A pending CSR that does not parse cannot be matched; not the
      // chain's fault.
    }
  }
  return { ok: true };
}

async function signedBy(
  cert: x509.X509Certificate,
  issuer: x509.X509Certificate,
): Promise<boolean> {
  try {
    return await cert.verify({
      publicKey: issuer.publicKey,
      signatureOnly: true,
    });
  } catch {
    return false;
  }
}

function fail(problem: SignedChainProblem, detail: string): SignedChainCheck {
  return { ok: false, problem, detail };
}
