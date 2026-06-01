import { atomWithStorage } from "jotai/utils";
import { BootNotification } from "../cp/domain/types/OcppTypes";

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

const key = "config";
export const configAtom = atomWithStorage<Config | null>(key, null, undefined, {
  getOnInit: true,
});
