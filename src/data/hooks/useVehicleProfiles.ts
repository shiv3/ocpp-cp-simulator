import { useEffect, useSyncExternalStore } from "react";

import type { VehicleProfile } from "../../cp/domain/vehicle/VehicleProfile";
import type { ChargePointService } from "../interfaces/ChargePointService";
import { useDataContext } from "../providers/DataProvider";

/**
 * The saved vehicle profiles (#458), one store per service so every reader on
 * the page — the Settings card that imports a profile and the pickers beside
 * it — sees the same list, and a save in one shows up in the others without a
 * reload.
 *
 * A failed read is reported, not turned into an empty list: `isKnown` stays
 * false and `error` says why, so a picker never offers "no profiles" when it
 * simply could not read them.
 */
export interface VehicleProfilesState {
  profiles: VehicleProfile[];
  /** A read has succeeded at least once. */
  isKnown: boolean;
  error: string | null;
}

export interface VehicleProfiles extends VehicleProfilesState {
  /** The service stores profiles (both console modes do). */
  supported: boolean;
  reload(): Promise<void>;
  save(profile: VehicleProfile): Promise<VehicleProfile>;
  remove(id: string): Promise<void>;
}

class VehicleProfileStore {
  private state: VehicleProfilesState = {
    profiles: [],
    isKnown: false,
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private started = false;
  /** Only the latest read may publish: an older one, started before a
   *  write, answers with a list that no longer holds. */
  private generation = 0;

  constructor(private readonly service: ChargePointService) {}

  get supported(): boolean {
    return typeof this.service.listVehicleProfiles === "function";
  }

  getSnapshot = (): VehicleProfilesState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Loads once; later mounts read the shared state. */
  ensureLoaded(): void {
    if (this.started) return;
    this.started = true;
    void this.reload();
  }

  reload = async (): Promise<void> => {
    if (!this.supported) return;
    this.started = true;
    const generation = ++this.generation;
    try {
      const profiles = (await this.service.listVehicleProfiles!()) ?? [];
      if (generation === this.generation) {
        this.set({ profiles, isKnown: true, error: null });
      }
    } catch (error) {
      console.error("Failed to load vehicle profiles", error);
      if (generation === this.generation) {
        this.set({ ...this.state, error: messageOf(error) });
      }
    }
  };

  save = async (profile: VehicleProfile): Promise<VehicleProfile> => {
    if (!this.service.saveVehicleProfile) {
      throw new Error("This console cannot store vehicle profiles");
    }
    const stored = await this.service.saveVehicleProfile(profile);
    await this.reload();
    return stored ?? profile;
  };

  remove = async (id: string): Promise<void> => {
    if (!this.service.deleteVehicleProfile) {
      throw new Error("This console cannot store vehicle profiles");
    }
    await this.service.deleteVehicleProfile(id);
    await this.reload();
  };

  private set(next: VehicleProfilesState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

const stores = new WeakMap<ChargePointService, VehicleProfileStore>();

/** For a service that stores no profiles: one inert store, so a service
 *  object rebuilt on every render does not make a new store each time. */
const UNSUPPORTED = new VehicleProfileStore({} as ChargePointService);

function storeFor(service: ChargePointService): VehicleProfileStore {
  if (typeof service.listVehicleProfiles !== "function") return UNSUPPORTED;
  let store = stores.get(service);
  if (!store) {
    store = new VehicleProfileStore(service);
    stores.set(service, store);
  }
  return store;
}

export function useVehicleProfiles(): VehicleProfiles {
  const { chargePointService } = useDataContext();
  const store = storeFor(chargePointService);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    store.ensureLoaded();
  }, [store]);
  return {
    ...state,
    supported: store.supported,
    reload: store.reload,
    save: store.save,
    remove: store.remove,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
