import {atom} from 'jotai';
import {atomWithStorage} from 'jotai/utils'
import {atomWithHash} from 'jotai-location'
import {BootNotification} from "../cp/OcppTypes.ts";


interface Config {
  wsURL: string;
  ChargePointID: string;
  connectorNumber: number;
  tagID: string
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


const key = "config"
const configHashAtom = atomWithHash<Config | null>(key, null);
const configStorageAtom = atomWithStorage<Config | null>(key, null, undefined, {getOnInit: true});
export const configAtom = atom(
  (get) => {
    const hashValue = get(configHashAtom);
    const storageValue = get(configStorageAtom);
    return hashValue ?? storageValue;
  },
  (_, set, update: Config) => {
    set(configHashAtom, update);
    set(configStorageAtom, update);
  }
);

