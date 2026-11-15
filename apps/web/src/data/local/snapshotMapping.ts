import type {
  ChargePointSnapshot,
  ConnectorSnapshot,
} from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import { isOneOf } from "@ocpp-cp-simulator/core/cp/domain/types/FirmwareLogStatus";
import { RpcFailure } from "@ocpp-cp-simulator/contracts/errors";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";

export function toConnectorSnapshot(
  connector: ReturnType<ChargePoint["getConnector"]>,
): ConnectorSnapshot | null {
  if (!connector) return null;
  const tx = connector.transaction;
  return {
    id: connector.id,
    status: connector.status as OCPPStatus,
    availability: connector.availability,
    meterValue: connector.meterValue,
    transactionId: tx?.id ?? null,
    soc: connector.soc,
    mode: connector.mode,
    autoResetToAvailable: connector.autoResetToAvailable,
    autoMeterValueConfig: connector.autoMeterValueConfig,
    evSettings: connector.evSettings,
    chargingProfile: connector.chargingProfile,
    chargingProfiles: [...connector.chargingProfiles],
    transactionStartTime: tx?.startTime ?? null,
    transactionTagId: tx?.tagId ?? null,
    transactionBatteryCapacityKwh: tx?.batteryCapacityKwh ?? null,
    evConnection: connector.evConnection,
  };
}

export function toChargePointSnapshot(cp: ChargePoint): ChargePointSnapshot {
  const connectors: ConnectorSnapshot[] = [];
  cp.connectors.forEach((connector) => {
    const snapshot = toConnectorSnapshot(connector);
    if (snapshot) connectors.push(snapshot);
  });

  return {
    id: cp.id,
    status: cp.status,
    error: cp.error,
    connectors,
    heartbeat: {
      intervalSeconds: cp.heartbeat.intervalSeconds,
      lastSentAt: cp.heartbeat.lastSentAt
        ? cp.heartbeat.lastSentAt.toISOString()
        : null,
    },
    networkSim: cp.networkSimSummary(),
    ...(cp.modemState() ? { modem: cp.modemState()! } : {}),
  };
}

/**
 * Browser mode has no control-plane schema in front of it, so this adapter
 * is where an untyped caller's status is narrowed (#377). It refuses an
 * unknown value with the `invalid_params` failure the daemon path surfaces,
 * instead of letting it reach the wire.
 */
export function requireStatus(
  status: string,
  allowed: readonly string[],
): void {
  if (!isOneOf(status, allowed)) {
    throw new RpcFailure(
      "invalid_params",
      `Invalid parameter: status (expected one of ${allowed.join(", ")})`,
    );
  }
}
