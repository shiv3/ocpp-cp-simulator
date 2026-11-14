/**
 * Where one charge point's cellular modem and SIM state is kept (#928): a
 * single JSON document, so a restart finds the card, its subscription state
 * and the selected interface as they were. Decoding and validation stay in
 * `CellularModem`. A failure throws; the modem logs nothing and carries on in
 * memory.
 *
 * `SqliteModemRepository` uses the `kv` row `modem:<cpId>`;
 * {@link NoopModemRepository} backs a charge point without a database.
 */
export interface ModemRepository {
  /** The stored document, or `null` when none is stored. */
  load(): string | null;
  save(document: string): void;
  /** Forget the stored document (the charge point is deleted). */
  delete(): void;
}

/** A charge point without a database: nothing is stored. */
export class NoopModemRepository implements ModemRepository {
  load(): string | null {
    return null;
  }

  save(_document: string): void {}

  delete(): void {}
}
