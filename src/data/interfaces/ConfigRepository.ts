import type { Config } from "../../store/store";

export interface ConfigRepository {
  load(): Promise<Config | null>;
  save(config: Config | null): Promise<void>;
  subscribe(handler: (config: Config | null) => void): () => void;
}
