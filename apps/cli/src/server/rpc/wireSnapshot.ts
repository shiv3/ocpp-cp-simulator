import type {
  ChargePointSnapshot,
  ConnectorSnapshot,
} from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import {
  registryCpToWire,
  statusToWire,
  type CpListItem,
  type StatusWire,
} from "@ocpp-cp-simulator/contracts/index";

type FullCp = Parameters<typeof registryCpToWire>[0];

export function snapshotToRegistryCpWire(
  snapshot: ChargePointSnapshot,
): CpListItem {
  return registryCpToWire(snapshotToFullCp(snapshot));
}

/**
 * `ChargePointSnapshot.config` is typed optional to cover Local mode
 * (the browser owns config) and older daemons that predate the field —
 * neither applies to a Registry-produced snapshot today, since
 * `CLIChargePointService.getStatus()` always populates it. Still, throwing
 * here would take down `listCps`/`captureSubscribeSnapshot` for every
 * registered CP over one anomalous snapshot; fall back to a minimal,
 * clearly-incomplete config and warn instead of crashing the RPC.
 */
export function snapshotToFullCp(snapshot: ChargePointSnapshot): FullCp {
  if (!snapshot.config) {
    console.warn(
      `[socketServer] CP snapshot missing config, using fallback: ${snapshot.id}`,
    );
    return {
      id: snapshot.id,
      status: snapshot.status,
      config: {
        wsUrl: "",
        connectors: snapshot.connectors.length,
        vendor: "",
        model: "",
        basicAuth: null,
        bootNotification: null,
      },
      networkSim: snapshot.networkSim,
    };
  }
  return {
    id: snapshot.id,
    status: snapshot.status,
    config: snapshot.config,
    networkSim: snapshot.networkSim,
  };
}

export function snapshotToWireStatus(
  snapshot: ChargePointSnapshot,
): StatusWire {
  return statusToWire({
    id: snapshot.id,
    status: snapshot.status,
    error: snapshot.error,
    connectors: snapshot.connectors.map(connectorSnapshotToWire),
    heartbeat: snapshot.heartbeat,
    networkSim: snapshot.networkSim,
    config: snapshot.config,
    modem: snapshot.modem,
  });
}

function connectorSnapshotToWire(
  connector: ConnectorSnapshot,
): StatusWire["connectors"][number] {
  return {
    id: connector.id,
    status: connector.status,
    availability: connector.availability,
    meterValue: connector.meterValue,
    transactionId: connector.transactionId,
    soc: connector.soc,
    mode: connector.mode,
    autoResetToAvailable: connector.autoResetToAvailable,
    autoMeterValueConfig: connector.autoMeterValueConfig as Record<
      string,
      unknown
    > | null,
    evSettings: connector.evSettings as Record<string, unknown> | null,
    chargingProfile: connector.chargingProfile as Record<
      string,
      unknown
    > | null,
    chargingProfiles: connector.chargingProfiles.map(
      (profile) => profile as unknown as Record<string, unknown>,
    ),
    transactionStartTime: toIsoStringOrNull(connector.transactionStartTime),
    transactionTagId: connector.transactionTagId,
    transactionBatteryCapacityKwh: connector.transactionBatteryCapacityKwh,
    evConnection: connector.evConnection,
  };
}

function toIsoStringOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}
