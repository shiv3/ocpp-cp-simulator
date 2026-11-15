import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { behaviorFitProblem } from "@ocpp-cp-simulator/core/cp/application/engine/behaviorFit";
import { isSoapVersion } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import {
  OcppSecurityProfileConfigError,
  type OcppTlsOptions,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/wsUrlWithBasic";
import {
  BehaviorNotLoadableError,
  type BehaviorLibrary,
} from "../../behavior/BehaviorLibrary";
import { buildSoapCallbackUrl } from "../../soapCallbackUrl";
import { DEFAULT_SOAP_PATH } from "../../soapPath";
import type { ChargePointInitOptions } from "../../types";
import { mergeTlsOptions } from "./rowMapping";
import { readTlsFromPaths } from "./tlsPaths";

interface SoapOptions {
  readonly soapPublicBaseUrl?: string | null;
  readonly soapPath?: string;
}

/** What {@link prepareInit} needs from the registry that owns it. */
export interface PrepareContext {
  readonly library: BehaviorLibrary;
  readonly options: { readonly allowInsecureTlsKeyPerms?: boolean };
}

export function checkFit(
  ocppVersion: string | undefined,
  behaviors: readonly Behavior[],
): void {
  for (const behavior of behaviors) {
    const problem = behaviorFitProblem(behavior, {
      ocppVersion: ocppVersion ?? "OCPP-1.6J",
    });
    if (problem) throw new BehaviorNotLoadableError(problem);
  }
}

/**
 * Fill in the SOAP callback URL from the daemon's public base when the
 * charge point has none. Done at instantiation — after create()/update()
 * have persisted the operator's own init — so the derived value never
 * reaches the DB row (a free-tier tunnel URL changes between runs) and a
 * restore re-derives it from whatever base the daemon has *now*.
 */
export function withDerivedSoapCallback(
  options: SoapOptions,
  init: ChargePointInitOptions,
): ChargePointInitOptions {
  if (init.soapCallbackUrl) return init;
  const base = options.soapPublicBaseUrl;
  if (!base || !isSoapVersion(init.ocppVersion)) return init;
  return {
    ...init,
    soapCallbackUrl: buildSoapCallbackUrl(
      base,
      init.cpId,
      init.soapPath ?? options.soapPath ?? DEFAULT_SOAP_PATH,
    ),
    soapCallbackUrlDerived: true,
  };
}

/**
 * Validate config-dependent security-profile requirements eagerly, before
 * create()/update() persist or mutate anything, so a bad request fails
 * atomically. Thrown as OcppSecurityProfileConfigError (rather than a
 * plain Error) so the RPC layer (socketServer.ts runFacadeOperation) can
 * map it to `invalid_params` with the human-readable message intact,
 * instead of it falling through to an opaque, unlogged "internal error".
 */
export function prepareInit(
  ctx: PrepareContext,
  init: ChargePointInitOptions,
): ChargePointInitOptions {
  // Ids only: an id that names no loaded behavior is refused here, before
  // anything is persisted, with the loaded ids in the message.
  if (init.behaviors !== undefined) ctx.library.check(init.behaviors);
  const selected = ctx.library.select(init.behaviors);
  checkFit(init.ocppVersion, selected);
  ctx.library.checkParams(selected, init.behaviorParams);
  if (
    (init.securityProfile === 1 || init.securityProfile === 2) &&
    !init.authorizationKey
  ) {
    throw new OcppSecurityProfileConfigError(
      `securityProfile ${init.securityProfile} requires authorizationKey.`,
    );
  }
  if (
    init.securityProfile === 3 &&
    !(init.tls?.cert && init.tls?.key) &&
    !(init.tlsCertPath && init.tlsKeyPath)
  ) {
    throw new OcppSecurityProfileConfigError(
      "securityProfile 3 requires client certificate and key TLS material.",
    );
  }
  const tlsFromPaths = readTlsFromInitPaths(ctx.options, init);
  if (!tlsFromPaths) return init;
  return {
    ...init,
    tls: init.tls ? mergeTlsOptions(init.tls, tlsFromPaths) : tlsFromPaths,
  };
}

function readTlsFromInitPaths(
  options: { readonly allowInsecureTlsKeyPerms?: boolean },
  init: ChargePointInitOptions,
): OcppTlsOptions | undefined {
  if (!init.tlsCaPath && !init.tlsCertPath && !init.tlsKeyPath) {
    return undefined;
  }
  return readTlsFromPaths(options, {
    cpId: init.cpId,
    tlsCaPath: init.tlsCaPath ?? null,
    tlsCertPath: init.tlsCertPath ?? null,
    tlsKeyPath: init.tlsKeyPath ?? null,
  });
}
