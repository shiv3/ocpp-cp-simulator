import "reflect-metadata";
import * as x509 from "@peculiar/x509";

import type {
  CertificateSignedRequestV16,
  CertificateSignedResponseV16,
} from "@ocpp-cp-sim/ocpp/index";
import { isValidCertificateSignedRequestV16 } from "@ocpp-cp-sim/ocpp/index";
import { CERTIFICATE_PEM_RE } from "../../../../domain/security/certificateHash";
import { checkSignedChain } from "../../../../domain/security/signedChain";
import type { HandlerOutcome } from "../../network-sim/ResponseEffectQueue";
import { LogType } from "../../../../shared/Logger";
import type { CallHandler, HandlerContext } from "../MessageHandlerRegistry";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

export class CertificateSignedHandler implements CallHandler<
  CertificateSignedRequestV16,
  CertificateSignedResponseV16
> {
  async handle(
    payload: CertificateSignedRequestV16,
    context: HandlerContext,
  ): Promise<CertificateSignedResponseV16 | HandlerOutcome> {
    if (!isValidCertificateSignedRequestV16(payload)) {
      context.logger.warn(
        "CertificateSigned rejected: invalid request payload",
        LogType.OCPP,
      );
      return { status: "Rejected" };
    }

    // A02.FR.07: a certificate that is not valid is answered Rejected,
    // discarded, and reported with an InvalidChargePointCertificate security
    // event once the answer is written.
    const rejectInvalid = (reason: string): HandlerOutcome => {
      context.logger.warn(
        `CertificateSigned rejected: ${reason}`,
        LogType.OCPP,
      );
      return {
        kind: "handler-outcome",
        payload: { status: "Rejected" },
        afterResponseSettled: () => {
          void context.chargePoint
            .sendSecurityEventNotification(
              "InvalidChargePointCertificate",
              reason,
            )
            .catch(() => undefined);
        },
      };
    };

    const chain = splitPemChain(payload.certificateChain);
    if (!chain) return rejectInvalid("malformed or empty certificate chain");

    // Check certificate quirk: requiredCertificateSignatureAlgorithms.
    // If set and non-empty, verify the leaf certificate's signature
    // algorithm is in the allowed list.
    const quirks = context.chargePoint.certificateQuirks;
    if (
      quirks.requiredCertificateSignatureAlgorithms &&
      quirks.requiredCertificateSignatureAlgorithms.length > 0
    ) {
      try {
        const leafPem = chain[0];
        const leafCert = new x509.X509Certificate(leafPem);
        const sigAlgName = leafCert.signatureAlgorithm.name;

        if (
          !quirks.requiredCertificateSignatureAlgorithms.includes(sigAlgName)
        ) {
          return rejectInvalid(
            `signature algorithm ${sigAlgName} not in [${quirks.requiredCertificateSignatureAlgorithms.join(", ")}] (certificate quirk)`,
          );
        }
      } catch (err) {
        context.logger.warn(
          `CertificateSigned: error checking signature algorithm: ${err instanceof Error ? err.message : String(err)}`,
          LogType.OCPP,
        );
        return { status: "Rejected" };
      }
    }

    // A02.FR.06 (#732): validity period, signature chain, the installed CSMS
    // roots and the pending CSR's key. Without a pending CSR (a chain pushed
    // unasked) the key is not compared.
    const store = context.chargePoint.certificateStore;
    const check = await checkSignedChain(chain, {
      now: context.chargePoint.nowDate(),
      trustedRoots: store
        .listRootCertificates(["CsmsRootCertificate"])
        .map((root) => root.pem),
      pendingCsr: store.pendingCsr("ChargingStationCertificate"),
    });
    if (!check.ok) return rejectInvalid(`${check.problem}: ${check.detail}`);

    await context.chargePoint.certificateStore.storeSignedChain(chain);
    context.logger.info(
      `CertificateSigned accepted: stored ${chain.length} certificate(s)`,
      LogType.OCPP,
    );
    return { status: "Accepted" };
  }
}

export function splitPemChain(pemChain: string): string[] | null {
  const matches = pemChain.match(CERTIFICATE_PEM_RE);
  if (!matches || matches.length === 0) return null;

  const strippedInput = pemChain.replace(/\s+/g, "");
  const strippedMatches = matches.join("").replace(/\s+/g, "");
  if (strippedInput !== strippedMatches) return null;

  try {
    for (const pem of matches) {
      new x509.X509Certificate(pem);
    }
  } catch {
    return null;
  }

  return matches.map((pem) => pem.trim());
}
