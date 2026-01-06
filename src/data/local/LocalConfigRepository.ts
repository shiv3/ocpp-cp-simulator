import { createStore } from "jotai/vanilla";
import type { Store } from "jotai/vanilla";

import type { ConfigRepository } from "../interfaces/ConfigRepository";
import type { Config } from "../../store/store";
import { configAtom } from "../../store/store";

export class LocalConfigRepository implements ConfigRepository {
  private readonly store: Store;

  constructor(store?: Store) {
    this.store = store ?? createStore();
  }

  async load(): Promise<Config | null> {
    return this.store.get(configAtom);
  }

  async save(config: Config | null): Promise<void> {
    this.store.set(configAtom, config);
  }

  subscribe(handler: (config: Config | null) => void): () => void {
    handler(this.store.get(configAtom));
    return this.store.sub(configAtom, () => {
      handler(this.store.get(configAtom));
    });
  }

  getStore(): Store {
    return this.store;
  }
}
