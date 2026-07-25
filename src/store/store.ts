import { atomWithStorage } from "jotai/utils";
import { BootNotification } from "../cp/domain/types/OcppTypes";
import type { NetworkSimLayerConfig } from "../cp/infrastructure/transport/network-sim/config";

export interface Config {
  wsURL: string;
  ChargePointID: string;
  connectorNumber: number;
  tagID: string;
  ocppVersion: string;
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

export interface NetworkSimStore {
  version: 1;
  global: NetworkSimLayerConfig | null;
  perCp: Record<string, NetworkSimLayerConfig>;
}

const key = "config";
export const configAtom = atomWithStorage<Config | null>(key, null, undefined, {
  getOnInit: true,
});

export const NETWORK_SIM_STORAGE_KEY = "networkSim";
export const networkSimAtom = atomWithStorage<NetworkSimStore>(
  NETWORK_SIM_STORAGE_KEY,
  { version: 1, global: null, perCp: {} },
  undefined,
  { getOnInit: true },
);
