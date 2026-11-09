import type {
  CertificateRepository,
  StoredCertificate,
} from "../../domain/persistence/CertificateRepository";
import type { Database } from "../../domain/persistence/Database";

/** One charge point's rows of the `certificates` table (#456, #878). */
export class SqliteCertificateRepository implements CertificateRepository {
  constructor(
    private readonly chargePointId: string,
    private readonly database: Database,
  ) {}

  loadAll(): StoredCertificate[] {
    return this.database
      .all<{
        seq: number;
        kind: string;
        certificate_use: string;
        body: string;
        installed_at: string;
      }>(
        "SELECT seq, kind, certificate_use, body, installed_at FROM certificates " +
          "WHERE cp_id = ? ORDER BY seq ASC",
        [this.chargePointId],
      )
      .map((row) => ({
        seq: row.seq,
        kind: row.kind,
        use: row.certificate_use,
        body: row.body,
        installedAt: row.installed_at,
      }));
  }

  insert(certificate: StoredCertificate): void {
    this.database.run(
      "INSERT INTO certificates (cp_id, seq, kind, certificate_use, body, installed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
      [
        this.chargePointId,
        certificate.seq,
        certificate.kind,
        certificate.use,
        certificate.body,
        certificate.installedAt,
      ],
    );
  }

  delete(seq: number): void {
    this.database.run("DELETE FROM certificates WHERE cp_id = ? AND seq = ?", [
      this.chargePointId,
      seq,
    ]);
  }

  clear(): void {
    this.database.run("DELETE FROM certificates WHERE cp_id = ?", [
      this.chargePointId,
    ]);
  }
}
