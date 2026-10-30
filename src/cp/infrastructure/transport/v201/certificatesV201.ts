import type {
  CertificateSignedRequestV201,
  DeleteCertificateRequestV201,
  GetInstalledCertificateIdsRequestV201,
  InstallCertificateRequestV201,
} from "../../../../ocpp";
import type {
  CertificateSignedResponseV21,
  DeleteCertificateResponseV21,
  GetInstalledCertificateIdsResponseV21,
  InstallCertificateResponseV21,
} from "../../../../ocpp/v21";
import type {
  DeleteCertificateOutcome,
  InstalledCertificateIds,
} from "../../../domain/security/CertificateStore";
import type { CertificateHashData } from "../../../domain/security/certificateHash";
import type {
  InstalledCertificateQuery,
  RootCertificateUse,
  SignedCertificateUse,
} from "../../../domain/security/certificateUse";
import { LogType } from "../../../shared/Logger";
import {
  installedCertificateQueryFromV201,
  installedCertificateQueryFromV21,
  installedCertificateQueryToV201,
  installedCertificateQueryToV21,
  rootUseFromV201,
  rootUseFromV21,
  signedUseFromV201,
  signedUseFromV21,
} from "../certificateUseMapping";
import { splitPemChain } from "../handlers/call/CertificateSignedHandler";
import type {
  V201HandlerResult,
  V201InboundContext,
  V201InboundHandler,
} from "./inboundRegistryV201";

/**
 * OCPP 2.0.1 / 2.1 certificate management on the station's CertificateStore
 * (#456): M05 InstallCertificate, M03 GetInstalledCertificateIds, M04
 * DeleteCertificate and A02/A03 CertificateSigned. Both versions share these
 * handlers; only the enum mapping differs (2.1 adds OEMRootCertificate and
 * V2G20Certificate), so each registry builds them with its own mapping.
 * The 2.x responses are the 2.1 types, a superset of the 2.0.1 ones.
 */

/** The wire ↔ domain mapping one OCPP 2.x version uses. */
export interface CertificateWireMapping {
  readonly rootUseFrom: (value: string) => RootCertificateUse | undefined;
  readonly queryFrom: (value: string) => InstalledCertificateQuery | undefined;
  readonly queryTo: (query: InstalledCertificateQuery) => string | undefined;
  readonly signedUseFrom: (value: string) => SignedCertificateUse | undefined;
}

export const V201_CERTIFICATE_MAPPING: CertificateWireMapping = {
  rootUseFrom: rootUseFromV201,
  queryFrom: installedCertificateQueryFromV201,
  queryTo: installedCertificateQueryToV201,
  signedUseFrom: signedUseFromV201,
};

export const V21_CERTIFICATE_MAPPING: CertificateWireMapping = {
  rootUseFrom: rootUseFromV21,
  queryFrom: installedCertificateQueryFromV21,
  queryTo: installedCertificateQueryToV21,
  signedUseFrom: signedUseFromV21,
};

/** `childCertificateHashData` is 0..4 in both 2.0.1 and 2.1. */
const MAX_CHILD_HASH_DATA = 4;

type CertificateHashDataChain = NonNullable<
  GetInstalledCertificateIdsResponseV21["certificateHashDataChain"]
>[number];
type WireHashData = CertificateHashDataChain["certificateHashData"];

function wireHashData(hash: CertificateHashData): WireHashData {
  return { ...hash };
}

type CertificateAction =
  | "InstallCertificate"
  | "GetInstalledCertificateIds"
  | "DeleteCertificate"
  | "CertificateSigned";

/** The four certificate handlers of one 2.x version. */
export function buildCertificateHandlersV2x(
  mapping: CertificateWireMapping,
): Record<CertificateAction, V201InboundHandler["handle"]> {
  return {
    InstallCertificate: (payload, ctx) =>
      installCertificate(mapping, payload, ctx),
    GetInstalledCertificateIds: (payload, ctx) =>
      getInstalledCertificateIds(mapping, payload, ctx),
    DeleteCertificate: deleteCertificate,
    CertificateSigned: (payload, ctx) =>
      certificateSigned(mapping, payload, ctx),
  };
}

/**
 * Runs `read` on the store after every certificate operation dispatched
 * before it (an install still hashing), then builds the answer. The answer
 * stays synchronous when the store is idle, so the dispatcher sends it in
 * the tick of its CALL.
 */
function afterPendingOperations<T>(
  ctx: V201InboundContext,
  read: () => T,
  answer: (value: T) => V201HandlerResult,
): V201HandlerResult | Promise<V201HandlerResult> {
  const value = ctx.chargePoint.certificateStore.runExclusive(read);
  return value instanceof Promise
    ? value.then((v: Awaited<T>) => answer(v as T))
    : answer(value as T);
}

/**
 * M05: Accepted once installed (M05.FR.02); Rejected for a certificate that
 * does not parse (M05.FR.07) or when the store already holds
 * `CertificateStoreMaxLength` roots (M05.FR.06: that key is the
 * `CertificateEntries.maxLimit`, and `SecurityCtrlr.CertificateEntries`
 * reports the same root count, #537). A certificate already
 * installed replaces the old copy and is Accepted, full store or not
 * (M05.FR.17; AdditionalRootCertificateCheck, M05.FR.10, is not
 * implemented). Failed when the state database refuses it (M05.FR.03).
 */
async function installCertificate(
  mapping: CertificateWireMapping,
  payload: unknown,
  ctx: V201InboundContext,
): Promise<V201HandlerResult> {
  const req = payload as InstallCertificateRequestV201;
  const rejected = {
    response: { status: "Rejected" } satisfies InstallCertificateResponseV21,
  };
  const use = mapping.rootUseFrom(req.certificateType);
  if (!use) {
    // The validator already refuses a value this version does not define.
    ctx.logger.warn(
      `InstallCertificate rejected: unsupported certificateType ${req.certificateType}`,
      LogType.OCPP,
    );
    return rejected;
  }
  const maxEntries = ctx.chargePoint.configuration.certificateStoreMaxLength();
  const outcome = await ctx.chargePoint.certificateStore.installRootCertificate(
    use,
    req.certificate,
    { maxEntries, replaceDuplicate: true },
  );
  switch (outcome.status) {
    case "Installed":
      ctx.logger.info(
        `InstallCertificate accepted: type=${req.certificateType}`,
        LogType.OCPP,
      );
      return {
        response: {
          status: "Accepted",
        } satisfies InstallCertificateResponseV21,
      };
    case "StoreFull":
      ctx.logger.warn(
        `InstallCertificate rejected: store at CertificateStoreMaxLength (${outcome.limit})`,
        LogType.OCPP,
      );
      return rejected;
    case "Malformed":
      ctx.logger.warn(
        "InstallCertificate rejected: malformed certificate",
        LogType.OCPP,
      );
      return rejected;
    case "PersistFailed":
      ctx.logger.error(
        "InstallCertificate failed: the certificate could not be saved",
        LogType.OCPP,
      );
      return {
        response: { status: "Failed" } satisfies InstallCertificateResponseV21,
      };
  }
}

/**
 * M03: every installed certificate matching `certificateType` (all of them
 * when it is absent), Accepted with their hash data (M03.FR.03/04), else
 * NotFound (M03.FR.02). A V2G chain lists its sub-CAs as children
 * (M03.FR.05), capped at the schema's 4. A certificate whose use this
 * version has no name for (an OEM root installed under 2.1, read back on
 * 2.0.1 from the same state database) is left out.
 */
function getInstalledCertificateIds(
  mapping: CertificateWireMapping,
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult | Promise<V201HandlerResult> {
  const req = payload as GetInstalledCertificateIdsRequestV201;
  const queries = req.certificateType?.flatMap((value) => {
    const query = mapping.queryFrom(value);
    return query ? [query] : [];
  });
  return afterPendingOperations(
    ctx,
    () => ctx.chargePoint.certificateStore.installedCertificateIds(queries),
    (installed) => answerInstalledCertificateIds(mapping, installed, ctx),
  );
}

function answerInstalledCertificateIds(
  mapping: CertificateWireMapping,
  installed: readonly InstalledCertificateIds[],
  ctx: V201InboundContext,
): V201HandlerResult {
  const chain = installed.flatMap((entry): CertificateHashDataChain[] => {
    const certificateType = mapping.queryTo(entry.use);
    if (certificateType === undefined) return [];
    let children = entry.childHashData;
    if (children.length > MAX_CHILD_HASH_DATA) {
      ctx.logger.warn(
        `GetInstalledCertificateIds: ${children.length} sub-CA certificates under one ${certificateType}; reporting the first ${MAX_CHILD_HASH_DATA}`,
        LogType.OCPP,
      );
      children = children.slice(0, MAX_CHILD_HASH_DATA);
    }
    return [
      {
        certificateType:
          certificateType as CertificateHashDataChain["certificateType"],
        certificateHashData: wireHashData(entry.hashData),
        ...(children.length > 0
          ? {
              childCertificateHashData: children.map(
                wireHashData,
              ) as CertificateHashDataChain["childCertificateHashData"],
            }
          : {}),
      },
    ];
  });
  const [first, ...rest] = chain;
  if (first === undefined) {
    ctx.logger.info(
      "GetInstalledCertificateIds: no installed certificate matched",
      LogType.OCPP,
    );
    return {
      response: {
        status: "NotFound",
      } satisfies GetInstalledCertificateIdsResponseV21,
    };
  }
  ctx.logger.info(
    `GetInstalledCertificateIds: returning ${chain.length} entr${chain.length === 1 ? "y" : "ies"}`,
    LogType.OCPP,
  );
  return {
    response: {
      status: "Accepted",
      certificateHashDataChain: [first, ...rest],
    } satisfies GetInstalledCertificateIdsResponseV21,
  };
}

/**
 * M04: Accepted once deleted (M04.FR.02), NotFound for an unknown hash
 * (M04.FR.04), Failed for the Charging Station certificate (M04.FR.06).
 */
function deleteCertificate(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult | Promise<V201HandlerResult> {
  const req = payload as DeleteCertificateRequestV201;
  const store = ctx.chargePoint.certificateStore;
  return afterPendingOperations(
    ctx,
    () => store.deleteCertificate(req.certificateHashData),
    (outcome) => answerDeleteCertificate(outcome, ctx),
  );
}

function answerDeleteCertificate(
  outcome: DeleteCertificateOutcome,
  ctx: V201InboundContext,
): V201HandlerResult {
  switch (outcome.status) {
    case "Deleted":
      ctx.logger.info(
        `DeleteCertificate accepted: removed ${outcome.use}`,
        LogType.OCPP,
      );
      return {
        response: { status: "Accepted" } satisfies DeleteCertificateResponseV21,
      };
    case "NotFound":
      ctx.logger.info(
        "DeleteCertificate: no installed certificate matched the given hash data",
        LogType.OCPP,
      );
      return {
        response: { status: "NotFound" } satisfies DeleteCertificateResponseV21,
      };
    case "ChargingStationCertificate":
      ctx.logger.warn(
        "DeleteCertificate refused: the Charging Station certificate cannot be deleted",
        LogType.OCPP,
      );
      return {
        response: { status: "Failed" } satisfies DeleteCertificateResponseV21,
      };
  }
}

/**
 * A02 / A03: the chain is accepted only when it parses, a CSR is pending
 * for its use, and the leaf carries that CSR's public key (A02.FR.06).
 * Anything else is Rejected and raises an
 * `InvalidChargingStationCertificate` security event once the answer is
 * written (A02.FR.07). An absent `certificateType` means the certificate
 * serves both the CSMS and the 15118 connection; the simulator has no
 * 15118 stack, so it is the Charging Station certificate.
 */
async function certificateSigned(
  mapping: CertificateWireMapping,
  payload: unknown,
  ctx: V201InboundContext,
): Promise<V201HandlerResult> {
  const req = payload as CertificateSignedRequestV201;
  // #537 A02.FR.16: SHALL on 2.0.1, MAY on 2.1; the station applies it on
  // both. A02.FR.16 asks for Rejected only, so no security event is sent.
  const maxChainSize = ctx.chargePoint.configuration.maxCertificateChainSize();
  if (req.certificateChain.length > maxChainSize) {
    ctx.logger.warn(
      `CertificateSigned rejected: certificateChain is ${req.certificateChain.length} characters, over MaxCertificateChainSize (${maxChainSize})`,
      LogType.OCPP,
    );
    return {
      response: { status: "Rejected" } satisfies CertificateSignedResponseV21,
    };
  }
  const use =
    req.certificateType === undefined
      ? "ChargingStationCertificate"
      : mapping.signedUseFrom(req.certificateType);
  // #537: a CertificateSigned for `use` ends its CSR's resend back-off,
  // accepted (A02.FR.17) or rejected as invalid (A02.FR.20).
  if (use) ctx.certificateSigning?.certificateSignedAnswered(use);
  const pems = splitPemChain(req.certificateChain);
  let reason: string;
  if (!use) {
    reason = `unsupported certificateType ${req.certificateType}`;
  } else if (!pems) {
    reason = "malformed or empty certificate chain";
  } else {
    const outcome = await ctx.chargePoint.certificateStore.applySignedChain(
      use,
      pems,
    );
    if (outcome.status === "Accepted") {
      ctx.logger.info(
        `CertificateSigned accepted: stored ${pems.length} certificate(s) as ${use}`,
        LogType.OCPP,
      );
      return {
        response: { status: "Accepted" } satisfies CertificateSignedResponseV21,
      };
    }
    reason = {
      Malformed: "malformed certificate chain",
      NoPendingCsr: `no pending CSR for ${use}`,
      PublicKeyMismatch: "the leaf does not match the pending CSR's public key",
    }[outcome.status];
  }
  ctx.logger.warn(`CertificateSigned rejected: ${reason}`, LogType.OCPP);
  return {
    response: { status: "Rejected" } satisfies CertificateSignedResponseV21,
    afterResult: () =>
      ctx.sendCall("SecurityEventNotification", {
        type: "InvalidChargingStationCertificate",
        timestamp: new Date().toISOString(),
        techInfo: reason,
      }),
  };
}
