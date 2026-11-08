import { atomWithStorage } from "jotai/utils";
import type {
  AutoMeterValueSetting,
  BasicAuthSettings,
  Config,
  Experimental,
} from "@ocpp-cp-simulator/client/interfaces/ConfigRepository";
import type { NetworkSimLayerConfig } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";

// The config shape is owned by the ConfigRepository port (packages/client/src/interfaces),
// which the daemon-facing client package also uses; re-exported so the many
// importers of `Config` from this module keep working.
export type { AutoMeterValueSetting, BasicAuthSettings, Config, Experimental };

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
