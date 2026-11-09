/** One stored configuration override: the key and its JSON-encoded value. */
export interface StoredConfigurationOverride {
  readonly key: string;
  readonly value: string;
}

/**
 * Where one charge point's configuration overrides are kept (#878): the
 * values ChangeConfiguration / SetVariables wrote over the defaults, so they
 * survive a restart. Values are stored JSON-encoded; decoding, typing and
 * validation stay in `ConfigurationStore`. A failure throws: the store logs
 * it and carries on in memory.
 *
 * `SqliteConfigurationOverrideRepository` uses the `configuration` table;
 * {@link NoopConfigurationOverrideRepository} backs a charge point without a
 * database, whose overrides live in memory only.
 */
export interface ConfigurationOverrideRepository {
  /** Every stored override, in no particular order. */
  loadAll(): StoredConfigurationOverride[];
  /** The stored value of `key`, or `null` when none is stored. */
  get(key: string): string | null;
  /** Store `value` for `key`, replacing any previous one. */
  save(key: string, value: string): void;
}

/** A charge point without a database: nothing is stored. */
export class NoopConfigurationOverrideRepository implements ConfigurationOverrideRepository {
  loadAll(): StoredConfigurationOverride[] {
    return [];
  }

  get(_key: string): string | null {
    return null;
  }

  save(_key: string, _value: string): void {}
}
