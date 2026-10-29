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
import type { CertificateHashData } from "../../../../domain/security/certificateHash";
import { LogType } from "../../../../shared/Logger";
import { rootUseFromV16, rootUseToV16 } from "../../certificateUseMapping";
import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

/**
 * §2 InstallCertificate.req (OCPP 1.6 Security Whitepaper): stores a root
 * certificate (CentralSystemRootCertificate / ManufacturerRootCertificate)
 * for later use validating the CSMS or a firmware signer. `Rejected`
 * covers both a malformed/unparseable PEM and a full certificate store
 * (M05.FR.03 / M05.FR.06); `Failed` a certificate the state database
 * refused (M05.FR.04). The store hashes the certificate at install time,
 * so this handler is async.
 */
export class InstallCertificateHandler implements CallHandler<
  InstallCertificateRequestV16,
  InstallCertificateResponseV16
> {
  async handle(
    payload: InstallCertificateRequestV16,
    context: HandlerContext,
  ): Promise<InstallCertificateResponseV16> {
    const use = isValidInstallCertificateRequestV16(payload)
      ? rootUseFromV16(payload.certificateType)
      : undefined;
    if (!use) {
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

    const maxLength =
      context.chargePoint.configuration.certificateStoreMaxLength();
    const outcome =
      await context.chargePoint.certificateStore.installRootCertificate(
        use,
        payload.certificate,
        { maxEntries: maxLength },
      );
    switch (outcome.status) {
      case "Installed":
        context.logger.info(
          `InstallCertificate accepted: type=${payload.certificateType}`,
          LogType.OCPP,
        );
        return { status: "Accepted" };
      case "StoreFull":
        context.logger.warn(
          `InstallCertificate rejected: store at CertificateStoreMaxLength (${maxLength})`,
          LogType.OCPP,
        );
        return { status: "Rejected" };
      case "Malformed":
        context.logger.warn(
          "InstallCertificate rejected: malformed certificate",
          LogType.OCPP,
        );
        return { status: "Rejected" };
      case "PersistFailed":
        context.logger.error(
          "InstallCertificate failed: the certificate could not be saved",
          LogType.OCPP,
        );
        return { status: "Failed" };
    }
  }
}

/**
 * §2 GetInstalledCertificateIds.req: reports `certificateHashData` for
 * every stored root cert matching the requested `certificateType`
 * (M03.FR.02 NotFound / M03.FR.03-04 Accepted). The hash data was
 * computed at install time.
 */
export class GetInstalledCertificateIdsHandler implements CallHandler<
  GetInstalledCertificateIdsRequestV16,
  GetInstalledCertificateIdsResponseV16
> {
  async handle(
    payload: GetInstalledCertificateIdsRequestV16,
    context: HandlerContext,
  ): Promise<GetInstalledCertificateIdsResponseV16> {
    const use = isValidGetInstalledCertificateIdsRequestV16(payload)
      ? rootUseFromV16(payload.certificateType)
      : undefined;
    if (!use) {
      context.logger.warn(
        "GetInstalledCertificateIds: invalid request payload",
        LogType.OCPP,
      );
      return { status: "NotFound" };
    }

    // After any install dispatched before this query (CertificateStore
    // runs its operations one at a time).
    const store = context.chargePoint.certificateStore;
    const matches = await store.runExclusive(() =>
      store.listRootCertificates([use]),
    );

    if (matches.length === 0) {
      context.logger.info(
        `GetInstalledCertificateIds: no stored certs of type=${payload.certificateType}`,
        LogType.OCPP,
      );
      return { status: "NotFound" };
    }

    const certificateHashData = matches.map((cert) => ({
      ...cert.hashData,
    })) as [CertificateHashData, ...CertificateHashData[]];

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
 * carries no `certificateType`) and deletes on the first match. Signed
 * chains are outside the 1.6 scope: their hashes answer NotFound, which
 * also keeps the Charge Point Certificate undeletable (M04.FR.05).
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
    const deleted = await store.runExclusive(() =>
      store.deleteRootCertificate(payload.certificateHashData),
    );
    if (deleted) {
      context.logger.info(
        `DeleteCertificate accepted: removed type=${rootUseToV16(deleted.use) ?? deleted.use}`,
        LogType.OCPP,
      );
      return { status: "Accepted" };
    }

    context.logger.info(
      "DeleteCertificate: no stored cert matched the given hash data",
      LogType.OCPP,
    );
    return { status: "NotFound" };
  }
}
