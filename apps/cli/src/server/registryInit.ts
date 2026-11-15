import { isSoapVersion } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import type { CreateChargePointParams } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import type { ChargePointInitOptions } from "../types";
import type { JsonObject } from "@ocpp-cp-simulator/contracts/behavior";

export function toInitOptions(
  params: CreateChargePointParams,
  existing?: ChargePointInitOptions,
): ChargePointInitOptions {
  return {
    cpId: params.cpId,
    wsUrl: params.wsUrl,
    // Without these two the whole feature is inert over the control plane:
    // `parseCreateBody` would produce the list, the facade would drop it, and
    // the charge point would come up on the first URL with no pool at all —
    // while `cp.create` answered success.
    //
    // No `existing` fallback, unlike the fields below it. `wsUrl` is required
    // on `cp.update`, so an update fully specifies the URL configuration:
    // falling back would leave a charge point updated to a single endpoint
    // still failing over to the stale pool, and still persisting it.
    supervisionUrls: params.supervisionUrls,
    urlDistribution: params.urlDistribution,
    // #609: an update that omits `transport` keeps the current settings.
    transport: params.transport ?? existing?.transport,
    // Same rule as the URLs above: `cp.update` fully specifies the pool, so
    // there is no `existing` fallback — an update that drops `idTagPool`
    // means the charge point no longer has one.
    idTags: params.idTags,
    // #314: the path travels with the list. Dropping it here is exactly the
    // failure #299 shipped with — the create reports success and the feature
    // (here, the watch) is inert.
    idTagFile: params.idTagFile,
    idTagDistribution: params.idTagDistribution,
    centralSystemUrl: params.centralSystemUrl ?? existing?.centralSystemUrl,
    // Same rule as the URLs above: an update fully specifies the callback
    // URL, so there is no `existing` fallback. An update without one asks the
    // registry to derive it from the daemon's SOAP public base — a cleared
    // field in the form, or a re-derivation of a URL the registry made up in
    // the first place, instead of freezing one run's tunnel origin into the
    // row (#183). Without a base the registry refuses, as `cp.create` does.
    soapCallbackUrl: params.soapCallbackUrl,
    soapPath: params.soapPath ?? existing?.soapPath,
    ocppVersion: params.ocppVersion ?? existing?.ocppVersion ?? "OCPP-1.6J",
    connectors: params.connectors ?? existing?.connectors ?? 1,
    vendor: params.vendor ?? existing?.vendor ?? "Server-Vendor",
    model: params.model ?? existing?.model ?? "Server-Model",
    basicAuth: toBasicAuth(params.basicAuth, existing?.basicAuth),
    securityProfile: params.securityProfile ?? existing?.securityProfile,
    authorizationKey: params.authorizationKey ?? existing?.authorizationKey,
    cpoName: params.cpoName ?? existing?.cpoName,
    txUpdatedMeterValues:
      params.txUpdatedMeterValues ?? existing?.txUpdatedMeterValues,
    inboundValidation: params.inboundValidation ?? existing?.inboundValidation,
    reservationAuthorizeIdTag:
      params.reservationAuthorizeIdTag ?? existing?.reservationAuthorizeIdTag,
    capabilityProfile: params.capabilityProfile ?? existing?.capabilityProfile,
    chargerCapabilities:
      params.chargerCapabilities ?? existing?.chargerCapabilities,
    modem: params.modem ?? existing?.modem,
    tls: params.tls ?? existing?.tls,
    tlsCaPath: params.tlsCaPath ?? existing?.tlsCaPath,
    tlsCertPath: params.tlsCertPath ?? existing?.tlsCertPath,
    tlsKeyPath: params.tlsKeyPath ?? existing?.tlsKeyPath,
    bootNotification:
      params.bootNotification ?? existing?.bootNotification ?? undefined,
    // #446: no `existing` fallback here — `CPRegistry.update` is the one place
    // that keeps the current labels when an update omits them.
    labels: params.labels,
    ...(params.behaviors === undefined ? {} : { behaviors: params.behaviors }),
    ...(params.behaviorParams === undefined
      ? {}
      : {
          behaviorParams: params.behaviorParams as Record<string, JsonObject>,
        }),
  };
}

export function toBasicAuth(
  input: CreateChargePointParams["basicAuth"],
  existing?: ChargePointInitOptions["basicAuth"],
): ChargePointInitOptions["basicAuth"] {
  if (input === null) return null;
  if (input === undefined) return existing ?? null;
  if (input.password === undefined && !existing) return null;
  return {
    username: input.username,
    password:
      input.password === undefined || input.password.length === 0
        ? (existing?.password ?? input.password ?? "")
        : input.password,
  };
}

/** #618: OCPP-S (SOAP) dispatch bypasses the inbound gate, so a capability
 *  profile would be accepted and then ignored; refuse it instead. */
export function refuseProfileOnSoap(
  params: CreateChargePointParams,
  existingVersion?: string,
): void {
  const version = params.ocppVersion ?? existingVersion ?? "OCPP-1.6J";
  if (params.capabilityProfile && isSoapVersion(version)) {
    throw new Error(
      "capabilityProfile is not supported for the OCPP SOAP versions: their calls do not pass the inbound gate",
    );
  }
}
