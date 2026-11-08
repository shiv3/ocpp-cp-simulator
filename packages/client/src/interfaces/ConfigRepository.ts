import type { BootNotification } from "@ocpp-cp-sim/core/cp/domain/types/OcppTypes";

export interface Config {
  wsURL: string;
  ChargePointID: string;
  connectorNumber: number;
  tagID: string;
  ocppVersion: string;
  /** #550: shared by every browser charge point; absent means off. */
  txUpdatedMeterValues?: boolean;
  basicAuthSettings: BasicAuthSettings;
  autoMeterValueSetting: AutoMeterValueSetting;
  Experimental: Experimental | null;
  BootNotification: BootNotification | null;
}

export interface BasicAuthSettings {
  enabled: boolean;
  username: string;
  password: string;
}

export interface AutoMeterValueSetting {
  enabled: boolean;
  interval: number;
  value: number;
}

export interface Experimental {
  ChargePointIDs: ExperimentalChargePoint[];
  TagIDs: string[];
}

interface ExperimentalChargePoint {
  ChargePointID: string;
  ConnectorNumber: number;
}

export interface ConfigRepository {
  load(): Promise<Config | null>;
  save(config: Config | null): Promise<void>;
  subscribe(handler: (config: Config | null) => void): () => void;
}
