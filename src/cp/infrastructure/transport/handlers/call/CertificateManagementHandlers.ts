import "reflect-metadata";
import * as x509 from "@peculiar/x509";

import type {
  DeleteCertificateRequestV16,
  DeleteCertificateResponseV16,
  GetInstalledCertificateIdsRequestV16,
  GetInstalledCertificateIdsResponseV16,
  InstallCertificateRequestV16,
  InstallCertificateResponseV16,
} from "../../../../../ocpp";
import {
  isValidDeleteCertificateRequestV16,
  isValidGetInstalledCertificateIdsRequestV16,
  isValidInstallCertificateRequestV16,
} from "../../../../../ocpp";
import {
  certificateHashDataEquals,
  computeCertificateHashData,
  type CertificateHashData,
} from "../../../../domain/security/certificateHash";
import { LogType } from "../../../../shared/Logger";
import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

/**
 * §2 InstallCertificate.req (OCPP 1.6 Security Whitepaper): stores a root
 * certificate (CentralSystemRootCertificate / ManufacturerRootCertificate)
 * for later use validating the CSMS or a firmware signer. `Rejected`
 * covers both a malformed/unparseable PEM and a full certificate store —
 * there is no dedicated status for the latter in the 1.6 whitepaper.
 */
export class InstallCertificateHandler implements CallHandler<
  InstallCertificateRequestV16,
  InstallCertificateResponseV16
> {
  handle(
    payload: InstallCertificateRequestV16,
    context: HandlerContext,
  ): InstallCertificateResponseV16 {
    if (!isValidInstallCertificateRequestV16(payload)) {
      context.logger.warn(
        "InstallCertificate rejected: invalid request payload",
        LogType.OCPP,
      );
      return { status: "Rejected" };
    }

    try {
      // Structural validation only; throws on malformed PEM.
      new x509.X509Certificate(payload.certificate);
    } catch {
      context.logger.warn(
        "InstallCertificate rejected: malformed certificate",
        LogType.OCPP,
      );
      return { status: "Rejected" };
    }

    const store = context.chargePoint.certificateStore;
    const maxLength =
      context.chargePoint.configuration.certificateStoreMaxLength();
    if (store.listRootCerts().length >= maxLength) {
      context.logger.warn(
        `InstallCertificate rejected: store at CertificateStoreMaxLength (${maxLength})`,
        LogType.OCPP,
      );
      return { status: "Rejected" };
    }

    store.installRootCert(payload.certificateType, payload.certificate.trim());
    context.logger.info(
      `InstallCertificate accepted: type=${payload.certificateType}`,
      LogType.OCPP,
    );
    return { status: "Accepted" };
  }
}

/**
 * §2 GetInstalledCertificateIds.req: reports `certificateHashData` for
 * every stored root cert matching the requested `certificateType`. Hash
 * computation is async (WebCrypto digest), so the registry's dispatch
 * loop awaits `handle()` — see `MessageHandlerRegistry.CallHandler`.
 */
export class GetInstalledCertificateIdsHandler implements CallHandler<
  GetInstalledCertificateIdsRequestV16,
  GetInstalledCertificateIdsResponseV16
> {
  async handle(
    payload: GetInstalledCertificateIdsRequestV16,
    context: HandlerContext,
  ): Promise<GetInstalledCertificateIdsResponseV16> {
    if (!isValidGetInstalledCertificateIdsRequestV16(payload)) {
      context.logger.warn(
        "GetInstalledCertificateIds: invalid request payload",
        LogType.OCPP,
      );
      return { status: "NotFound" };
    }

    const matches = context.chargePoint.certificateStore
      .listRootCerts()
      .filter((cert) => cert.type === payload.certificateType);

    if (matches.length === 0) {
      context.logger.info(
        `GetInstalledCertificateIds: no stored certs of type=${payload.certificateType}`,
        LogType.OCPP,
      );
      return { status: "NotFound" };
    }

    const certificateHashData = (await Promise.all(
      matches.map((cert) => computeCertificateHashData(cert.pem)),
    )) as [CertificateHashData, ...CertificateHashData[]];

    context.logger.info(
      `GetInstalledCertificateIds: returning ${certificateHashData.length} entr${
        certificateHashData.length === 1 ? "y" : "ies"
      } for type=${payload.certificateType}`,
      LogType.OCPP,
    );
    return { status: "Accepted", certificateHashData };
  }
}

/**
 * §2 DeleteCertificate.req: matches the request's `certificateHashData`
 * against every stored root cert (across both types — the request itself
 * carries no `certificateType`) and deletes on the first match.
 */
export class DeleteCertificateHandler implements CallHandler<
  DeleteCertificateRequestV16,
  DeleteCertificateResponseV16
> {
  async handle(
    payload: DeleteCertificateRequestV16,
    context: HandlerContext,
  ): Promise<DeleteCertificateResponseV16> {
    if (!isValidDeleteCertificateRequestV16(payload)) {
      context.logger.warn(
        "DeleteCertificate: invalid request payload",
        LogType.OCPP,
      );
      return { status: "Failed" };
    }

    const store = context.chargePoint.certificateStore;
    const target = payload.certificateHashData;
    for (const cert of store.listRootCerts()) {
      const hash = await computeCertificateHashData(cert.pem);
      if (certificateHashDataEquals(hash, target)) {
        store.deleteRootCert((c) => c.type === cert.type && c.pem === cert.pem);
        context.logger.info(
          `DeleteCertificate accepted: removed type=${cert.type}`,
          LogType.OCPP,
        );
        return { status: "Accepted" };
      }
    }

    context.logger.info(
      "DeleteCertificate: no stored cert matched the given hash data",
      LogType.OCPP,
    );
    return { status: "NotFound" };
  }
}
