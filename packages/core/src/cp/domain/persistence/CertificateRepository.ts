/**
 * One stored certificate entry: an installed root (`kind` "root") or a
 * signed chain (`kind` "chain"), with its JSON-encoded body. `kind` and
 * `use` are kept as stored; `CertificateStore` checks and decodes them.
 */
export interface StoredCertificate {
  /** Install order within the charge point; never reused. */
  readonly seq: number;
  readonly kind: string;
  readonly use: string;
  /** JSON: `{pem, hashData}` for a root, `{pems, hashData}` for a chain. */
  readonly body: string;
  readonly installedAt: string;
}

/**
 * Where one charge point's installed roots and signed chains are kept
 * (#456, #878), so they survive a restart. Pending CSRs and private keys are
 * never stored. A failure throws: `CertificateStore` logs it, and an install
 * whose insert threw answers `PersistFailed`.
 *
 * `SqliteCertificateRepository` uses the `certificates` table;
 * {@link NoopCertificateRepository} backs a charge point without a
 * database, whose certificates live in memory only.
 */
export interface CertificateRepository {
  /** Every stored entry, by ascending `seq`. */
  loadAll(): StoredCertificate[];
  insert(certificate: StoredCertificate): void;
  delete(seq: number): void;
  clear(): void;
}

/** A charge point without a database: nothing is stored, every write
 *  succeeds. */
export class NoopCertificateRepository implements CertificateRepository {
  loadAll(): StoredCertificate[] {
    return [];
  }

  insert(_certificate: StoredCertificate): void {}

  delete(_seq: number): void {}

  clear(): void {}
}
