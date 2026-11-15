import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type {
  ChargePointInitOptions,
  ChargePointStatus,
  ConnectorStatus,
} from "../types";

/** What the status / credential-change functions need from `CLIChargePointService`. */
export interface CpStatusHost {
  readonly chargePoint: ChargePoint;
  init: ChargePointInitOptions;
}

export function getStatus(host: CpStatusHost): ChargePointStatus {
  const connectors: ConnectorStatus[] = [];
  host.chargePoint.connectors.forEach((connector) => {
    const tx = connector.transaction;
    connectors.push({
      id: connector.id,
      status: connector.status,
      availability: connector.availability,
      meterValue: connector.meterValue,
      transactionId: tx?.id ?? null,
      soc: connector.soc,
      mode: connector.mode,
      autoResetToAvailable: connector.autoResetToAvailable,
      autoMeterValueConfig: connector.autoMeterValueConfig as unknown as Record<
        string,
        unknown
      >,
      evSettings: connector.evSettings as unknown as Record<string, unknown>,
      chargingProfile:
        (connector.chargingProfile as unknown as Record<string, unknown>) ??
        null,
      chargingProfiles: connector.chargingProfiles as unknown as ReadonlyArray<
        Record<string, unknown>
      >,
      transactionStartTime: tx?.startTime ? tx.startTime.toISOString() : null,
      transactionTagId: tx?.tagId ?? null,
      transactionBatteryCapacityKwh: tx?.batteryCapacityKwh ?? null,
      evConnection: connector.evConnection,
    });
  });

  return {
    id: host.chargePoint.id,
    status: host.chargePoint.status,
    error: host.chargePoint.error,
    connectors,
    heartbeat: {
      intervalSeconds: host.chargePoint.heartbeat.intervalSeconds,
      lastSentAt: host.chargePoint.heartbeat.lastSentAt
        ? host.chargePoint.heartbeat.lastSentAt.toISOString()
        : null,
    },
    networkSim: host.chargePoint.networkSimSummary(),
    ...(host.chargePoint.modemState()
      ? { modem: host.chargePoint.modemState()! }
      : {}),
    config: {
      wsUrl: host.init.wsUrl,
      connectors: host.init.connectors,
      vendor: host.init.vendor,
      model: host.init.model,
      basicAuth: host.init.basicAuth,
      centralSystemUrl: host.init.centralSystemUrl,
      soapCallbackUrl: host.init.soapCallbackUrl,
      soapCallbackUrlDerived: host.init.soapCallbackUrlDerived,
      soapPath: host.init.soapPath,
      ocppVersion: host.init.ocppVersion ?? "OCPP-1.6J",
      securityProfile: host.init.securityProfile,
      cpoName: host.init.cpoName,
      txUpdatedMeterValues: host.init.txUpdatedMeterValues,
      inboundValidation: host.init.inboundValidation,
      reservationAuthorizeIdTag: host.init.reservationAuthorizeIdTag,
      capabilityProfile: host.init.capabilityProfile,
      transport: host.init.transport,
      chargerCapabilities: host.init.chargerCapabilities,
      tlsCaPath: host.init.tlsCaPath,
      tlsCertPath: host.init.tlsCertPath,
      tlsKeyPath: host.init.tlsKeyPath,
      bootNotification: host.init.bootNotification ?? null,
      labels: host.init.labels,
      ...(host.init.behaviors === undefined
        ? {}
        : { behaviors: [...host.init.behaviors] }),
      ...(host.init.behaviorParams === undefined
        ? {}
        : { behaviorParams: { ...host.init.behaviorParams } }),
    },
  };
}

/**
 * #724: a ChangeConfiguration of `AuthorizationKey` / `SecurityProfile` (and
 * the A05.FR.08 fallback) is the station's new credential. `getInit()` follows
 * it, so a `cp.update` that omits the field keeps the changed value, and
 * `listener` lets the registry write it to the charge point's row: a restart
 * rebuilds the station from that row. Not for 2.x, which has no such keys.
 */
export function onSecurityCredentialsChange(
  host: CpStatusHost,
  listener: (change: {
    securityProfile?: 0 | 1 | 2 | 3;
    authorizationKey?: string;
  }) => void,
): () => void {
  if (host.init.ocppVersion?.startsWith("OCPP-2")) return () => {};
  return host.chargePoint.configuration.onChange((key, value) => {
    if (key === "AuthorizationKey" && typeof value === "string") {
      host.init = { ...host.init, authorizationKey: value };
      listener({ authorizationKey: value });
    } else if (
      key === "SecurityProfile" &&
      (value === 0 || value === 1 || value === 2 || value === 3)
    ) {
      host.init = { ...host.init, securityProfile: value };
      listener({ securityProfile: value });
    }
  });
}

/**
 * A simulated firmware update with `bumpVersion` changed the station's
 * firmwareVersion (`firmwareVersionChanged`). `listener` lets the registry
 * write it to the row's boot data: a restart boots with the installed
 * version, as a real station would. `getInit()` follows the change on its
 * own (see {@link attachEventForwarders}), with or without a listener, so
 * a `cp.update` that omits the field keeps the installed version however
 * the service was registered.
 */
export function onFirmwareVersionChange(
  host: CpStatusHost,
  listener: (
    bootNotification: NonNullable<ChargePointInitOptions["bootNotification"]>,
  ) => void,
): () => void {
  // Registered after the service's own subscription, so `_init` already
  // holds the new version when this runs.
  return host.chargePoint.events.on("firmwareVersionChanged", () => {
    const { bootNotification } = host.init;
    if (bootNotification) listener(bootNotification);
  });
}
