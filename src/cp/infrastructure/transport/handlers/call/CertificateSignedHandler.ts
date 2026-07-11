import "reflect-metadata";
import * as x509 from "@peculiar/x509";

import type {
  CertificateSignedRequestV16,
  CertificateSignedResponseV16,
} from "../../../../../ocpp";
import { isValidCertificateSignedRequestV16 } from "../../../../../ocpp";
import { LogType } from "../../../../shared/Logger";
import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

const CERTIFICATE_PEM_RE =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export class CertificateSignedHandler implements CallHandler<
  CertificateSignedRequestV16,
  CertificateSignedResponseV16
> {
  handle(
    payload: CertificateSignedRequestV16,
    context: HandlerContext,
  ): CertificateSignedResponseV16 {
    if (!isValidCertificateSignedRequestV16(payload)) {
      context.logger.warn(
        "CertificateSigned rejected: invalid request payload",
        LogType.OCPP,
      );
      return { status: "Rejected" };
    }

    const chain = splitPemChain(payload.certificateChain);
    if (!chain) {
      context.logger.warn(
        "CertificateSigned rejected: malformed or empty certificate chain",
        LogType.OCPP,
      );
      return { status: "Rejected" };
    }

    context.chargePoint.certificateStore.storeSignedChain(chain);
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
