import type { ChargePointSnapshot } from "../interfaces/ChargePointService";
import type {
  EVSettings,
  EVSettingsPatch,
} from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type { AutoTrafficConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/AutoTraffic";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
import type { ScenarioMode } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type {
  HistoryOptions,
  StateHistoryEntry,
} from "@ocpp-cp-simulator/core/cp/domain/services/StateSnapshot";
import {
  type Params,
  type Result,
  type RpcMethod,
} from "@ocpp-cp-simulator/contracts/index";

/** Connector-settings and state-history RPC wrappers of RemoteChargePointService (split out in #877). */
export interface RemoteConnectorRpcHost {
  rpc<M extends RpcMethod>(
    method: M,
    params: Params<M>,
    cpId?: string,
  ): Promise<Result<M>>;
  runCpRpc<M extends RpcMethod>(
    id: string,
    method: M,
    params?: Params<M>,
  ): Promise<Result<M>>;
  getChargePoint(id: string): Promise<ChargePointSnapshot | null>;
  setBounded<K, V>(map: Map<K, V>, key: K, value: V): void;
  readonly activeStateHistory: Map<string, HistoryOptions | undefined>;
}

export class RemoteConnectorRpc {
  constructor(private readonly host: RemoteConnectorRpcHost) {}

  async removeConnector(id: string, connectorId: number): Promise<void> {
    await this.host.runCpRpc(id, "remove_connector", {
      connector: connectorId,
    });
  }

  async setEVSettings(
    id: string,
    connectorId: number,
    settings: EVSettingsPatch,
  ): Promise<void> {
    await this.host.runCpRpc(id, "set_ev_settings", {
      connector: connectorId,
      settings: settings as unknown as Record<string, unknown>,
    });
  }

  async getEVSettings(
    id: string,
    connectorId: number,
  ): Promise<EVSettings | null> {
    const snapshot = await this.host.getChargePoint(id);
    const connector = snapshot?.connectors.find((c) => c.id === connectorId);
    return connector?.evSettings ?? null;
  }

  async applyDefaultEVSettings(settings: EVSettings): Promise<void> {
    // The daemon's connectors never see the browser-only Default EV Settings,
    // so push it onto every connector of every known charge point (#107) via
    // a single daemon-level RPC. This must NOT go through setEVSettings
    // (per-connector, marks an explicit override, #105) — the daemon-side
    // RegistryChargePointService.applyDefaultEVSettings routes it through
    // each connector's default-propagation path instead, so an active
    // scenario/explicit override isn't clobbered.
    await this.host.rpc("ev_settings.apply_default", {
      settings: settings as unknown as Record<string, unknown>,
    });
  }

  async setAutoMeterValueConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    await this.host.runCpRpc(id, "set_auto_meter_config", {
      connector: connectorId,
      config: config as unknown as Record<string, unknown>,
    });
  }

  async getAutoMeterValueConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    const snapshot = await this.host.getChargePoint(id);
    const connector = snapshot?.connectors.find((c) => c.id === connectorId);
    return connector?.autoMeterValueConfig ?? null;
  }

  async setAutoTrafficConfig(
    id: string,
    connectorId: number,
    config: AutoTrafficConfig,
  ): Promise<void> {
    await this.host.runCpRpc(id, "set_auto_traffic_config", {
      connector: connectorId,
      config: config as unknown as Record<string, unknown>,
    });
  }

  async getAutoTrafficConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoTrafficConfig | null> {
    const data = await this.host.rpc("connector_settings.auto_traffic.get", {
      cpId: id,
      connectorId,
    });
    return (data as unknown as AutoTrafficConfig | null) ?? null;
  }

  async saveAutoTrafficConfig(
    id: string,
    connectorId: number,
    config: AutoTrafficConfig,
  ): Promise<void> {
    await this.host.rpc("connector_settings.auto_traffic.save", {
      cpId: id,
      connectorId,
      config: config as unknown as Record<string, unknown>,
    });
  }

  async getAutoMeterConfig(
    id: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    const data = await this.host.rpc("connector_settings.auto_meter.get", {
      cpId: id,
      connectorId,
    });
    return (data as unknown as AutoMeterValueConfig | null) ?? null;
  }

  async saveAutoMeterConfig(
    id: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    await this.host.rpc("connector_settings.auto_meter.save", {
      cpId: id,
      connectorId,
      config: config as unknown as Record<string, unknown>,
    });
  }

  async setAutoResetToAvailable(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    await this.host.runCpRpc(id, "set_auto_reset_to_available", {
      connector: connectorId,
      enabled,
    });
  }

  async setConnectorMode(
    id: string,
    connectorId: number,
    mode: ScenarioMode,
  ): Promise<void> {
    await this.host.runCpRpc(id, "set_mode", { connector: connectorId, mode });
  }

  async setConnectorSoc(
    id: string,
    connectorId: number,
    soc: number | null,
  ): Promise<void> {
    await this.host.runCpRpc(id, "set_soc", { connector: connectorId, soc });
  }

  async setConnectorSocMeterSync(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    await this.host.runCpRpc(id, "set_soc_meter_sync", {
      connector: connectorId,
      enabled,
    });
  }

  async getSocMeterSync(id: string, connectorId: number): Promise<boolean> {
    return this.host.rpc("connector_settings.soc_meter_sync.get", {
      cpId: id,
      connectorId,
    });
  }

  async saveSocMeterSync(
    id: string,
    connectorId: number,
    enabled: boolean,
  ): Promise<void> {
    await this.host.rpc("connector_settings.soc_meter_sync.save", {
      cpId: id,
      connectorId,
      enabled,
    });
  }

  async getChargingProfiles(
    id: string,
    connectorId: number,
  ): Promise<ReadonlyArray<ActiveChargingProfile>> {
    const data = await this.host.runCpRpc(id, "get_charging_profiles", {
      connector: connectorId,
    });
    return (data as ActiveChargingProfile[]) ?? [];
  }

  async getStateHistory(
    id: string,
    options?: HistoryOptions,
  ): Promise<StateHistoryEntry[]> {
    this.host.setBounded(this.host.activeStateHistory, id, options);
    const data = await this.host.runCpRpc(
      id,
      "get_state_history",
      (options ? { options } : {}) as Params<"get_state_history">,
    );
    const list = (data as Array<Record<string, unknown>>) ?? [];
    return list.map((raw) => ({
      ...raw,
      timestamp:
        typeof raw.timestamp === "string"
          ? new Date(raw.timestamp)
          : new Date(),
    })) as unknown as StateHistoryEntry[];
  }
}
