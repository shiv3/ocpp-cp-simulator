import { atom } from "jotai";
import { atomWithStorage, RESET } from "jotai/utils";
import { atomWithHash } from "jotai-location";
import { BootNotification } from "../cp/OcppTypes.ts";

export interface Config {
  wsURL: string;
  ChargePointID: string;
  connectorNumber: number;
  tagID: string;
  ocppVersion: string;
  authToken: string;
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

export interface SimulatorProfile {
  id: string;
  name: string;
  config: Config;
}

export interface ProfilesState {
  v: 1;
  profiles: SimulatorProfile[];
  activeProfileId: string;
}

const CONFIG_HASH_PARAM = "config";
const PROFILES_STORAGE_KEY = "ocppCpProfiles";
const LEGACY_CONFIG_KEY = "config";

export function createEmptyConfig(): Config {
  return {
    wsURL: "",
    connectorNumber: 2,
    ChargePointID: "",
    tagID: "",
    ocppVersion: "OCPP-1.6J",
    authToken: "",
    basicAuthSettings: { enabled: false, username: "", password: "" },
    autoMeterValueSetting: { enabled: false, interval: 0, value: 0 },
    Experimental: null,
    BootNotification: null,
  };
}

function isConfigLike(x: unknown): x is Config {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.wsURL === "string" && typeof o.ChargePointID === "string";
}

function parseProfilesState(raw: string): ProfilesState | null {
  try {
    const o: unknown = JSON.parse(raw);
    if (typeof o !== "object" || o === null) return null;
    const r = o as Record<string, unknown>;
    // Loose `v` check: some serializers / hand edits use `"1"` or omit `v`
    const vOk = r.v === 1 || r.v === "1" || Number(r.v) === 1;
    if (
      vOk &&
      Array.isArray(r.profiles) &&
      typeof r.activeProfileId === "string"
    ) {
      return o as ProfilesState;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Recover multi-profile data when strict parse fails (avoid wiping localStorage). */
function tryRecoverProfilesState(raw: string): ProfilesState | null {
  try {
    const o: unknown = JSON.parse(raw);
    if (typeof o !== "object" || o === null) return null;
    const rec = o as Record<string, unknown>;
    if (!Array.isArray(rec.profiles)) return null;
    const profiles: SimulatorProfile[] = [];
    for (const item of rec.profiles) {
      if (typeof item !== "object" || item === null) continue;
      const p = item as Record<string, unknown>;
      if (typeof p.id !== "string" || typeof p.name !== "string") continue;
      const config: Config =
        typeof p.config === "object" &&
        p.config !== null &&
        isConfigLike(p.config)
          ? (p.config as Config)
          : createEmptyConfig();
      profiles.push({
        id: p.id,
        name: p.name,
        config,
      });
    }
    if (profiles.length === 0) return null;
    const declared =
      typeof rec.activeProfileId === "string" ? rec.activeProfileId : "";
    const activeProfileId = profiles.some((x) => x.id === declared)
      ? declared
      : profiles[0].id;
    return { v: 1, profiles, activeProfileId };
  } catch {
    return null;
  }
}

function sanitizeProfilesState(state: ProfilesState): ProfilesState {
  if (state.profiles.length === 0) {
    return defaultProfilesState();
  }
  if (!state.profiles.some((p) => p.id === state.activeProfileId)) {
    return { ...state, activeProfileId: state.profiles[0].id };
  }
  return state;
}

function migrateFromLegacy(): ProfilesState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const legacyRaw = localStorage.getItem(LEGACY_CONFIG_KEY);
    if (!legacyRaw) return null;
    const parsed: unknown = JSON.parse(legacyRaw);
    if (!isConfigLike(parsed)) return null;
    const id = crypto.randomUUID();
    const state: ProfilesState = {
      v: 1,
      profiles: [{ id, name: "Setting 1", config: parsed }],
      activeProfileId: id,
    };
    localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(state));
    localStorage.removeItem(LEGACY_CONFIG_KEY);
    return state;
  } catch {
    return null;
  }
}

function defaultProfilesState(): ProfilesState {
  const id = crypto.randomUUID();
  return {
    v: 1,
    profiles: [{ id, name: "Setting 1", config: createEmptyConfig() }],
    activeProfileId: id,
  };
}

const profilesSyncStorage: {
  getItem: (key: string, initialValue: ProfilesState) => ProfilesState;
  setItem: (key: string, newValue: ProfilesState) => void;
  removeItem: (key: string) => void;
  subscribe: (
    key: string,
    callback: (value: ProfilesState) => void,
    initialValue: ProfilesState,
  ) => () => void;
} = {
  getItem(key, initialValue) {
    void initialValue;
    if (typeof localStorage === "undefined") {
      return defaultProfilesState();
    }
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = parseProfilesState(raw);
        if (parsed) return sanitizeProfilesState(parsed);
        const recovered = tryRecoverProfilesState(raw);
        if (recovered) {
          const sane = sanitizeProfilesState(recovered);
          localStorage.setItem(key, JSON.stringify(sane));
          return sane;
        }
        // Non-empty but unreadable: do not overwrite disk with a single default
        // (that used to wipe multi-profile saves when strict parse failed).
        return sanitizeProfilesState(defaultProfilesState());
      }
      const migrated = migrateFromLegacy();
      if (migrated) return sanitizeProfilesState(migrated);
      const fresh = defaultProfilesState();
      localStorage.setItem(key, JSON.stringify(fresh));
      return fresh;
    } catch {
      return defaultProfilesState();
    }
  },
  setItem(key, newValue) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, JSON.stringify(newValue));
  },
  removeItem(key) {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(key);
  },
  subscribe(key, callback, initialValue) {
    if (typeof window === "undefined") {
      return () => {};
    }
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage || e.key !== key) return;
      if (e.newValue == null) {
        callback(initialValue);
        return;
      }
      const parsed = parseProfilesState(e.newValue);
      if (parsed) {
        callback(sanitizeProfilesState(parsed));
        return;
      }
      const recovered = tryRecoverProfilesState(e.newValue);
      if (recovered) {
        callback(sanitizeProfilesState(recovered));
        return;
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  },
};

export const profilesStateAtom = atomWithStorage<ProfilesState>(
  PROFILES_STORAGE_KEY,
  defaultProfilesState(),
  profilesSyncStorage,
  { getOnInit: true },
);

const configHashAtom = atomWithHash<Config | null>(CONFIG_HASH_PARAM, null);

export const clearConfigHashAtom = atom(null, (_get, set) => {
  set(configHashAtom, RESET);
});

function getActiveProfile(state: ProfilesState): SimulatorProfile | undefined {
  return state.profiles.find((p) => p.id === state.activeProfileId);
}

export const setActiveProfileIdAtom = atom(
  null,
  (_get, set, profileId: string) => {
    set(configHashAtom, RESET);
    set(profilesStateAtom, (prev) => {
      if (!prev.profiles.some((p) => p.id === profileId)) return prev;
      return { ...prev, activeProfileId: profileId };
    });
  },
);

/** Persist config on the active profile only (localStorage). Does not update URL hash. */
export const saveActiveProfileConfigAtom = atom(
  null,
  (_get, set, update: Config) => {
    set(profilesStateAtom, (prev) => {
      const activeId = prev.activeProfileId;
      return {
        ...prev,
        profiles: prev.profiles.map((p) =>
          p.id === activeId ? { ...p, config: update } : p,
        ),
      };
    });
  },
);

/** Next name in the form "Setting 1", "Setting 2", … */
export function nextSettingName(profiles: SimulatorProfile[]): string {
  const nums = profiles
    .map((p) => p.name)
    .map((n) => /^Setting (\d+)$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => parseInt(m[1], 10));
  let n = 1;
  while (nums.includes(n)) n += 1;
  return `Setting ${n}`;
}

export function nextCopyName(
  profiles: SimulatorProfile[],
  baseName: string,
): string {
  const stem = `${baseName} (copy)`;
  if (!profiles.some((p) => p.name === stem)) return stem;
  let i = 2;
  while (profiles.some((p) => p.name === `${stem} ${i}`)) i += 1;
  return `${stem} ${i}`;
}

export const configAtom = atom(
  (get) => {
    const hashValue = get(configHashAtom);
    if (hashValue) return hashValue;
    const state = get(profilesStateAtom);
    return getActiveProfile(state)?.config ?? null;
  },
  (_get, set, update: Config) => {
    // Functional update so we always merge into the latest profiles list
    // (avoids losing profiles when another tab or an earlier write updated storage).
    set(profilesStateAtom, (prev) => {
      const sane = sanitizeProfilesState(prev);
      const activeId = sane.activeProfileId;
      const nextProfiles = sane.profiles.map((p) =>
        p.id === activeId ? { ...p, config: update } : p,
      );
      return { ...sane, profiles: nextProfiles };
    });
    set(configHashAtom, update);
  },
);
