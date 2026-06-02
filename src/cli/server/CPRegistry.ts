import { CLIChargePointService } from "../service";
import type { ChargePointInitOptions } from "../types";
import type { EventBus } from "./eventBus";
import type { Database } from "../../cp/domain/persistence/Database";

interface ChargePointRow {
  cp_id: string;
  ws_url: string;
  connectors: number;
  vendor: string;
  model: string;
  basic_auth: string | null;
  boot_notif: string | null;
  created_at: string;
}

export class CPRegistry {
  private readonly services = new Map<string, CLIChargePointService>();
  private readonly unsubscribes = new Map<string, () => void>();

  constructor(
    private readonly bus: EventBus,
    /** Shared daemon DB threaded into every CLIChargePointService we
     *  create. `null` keeps everything in-memory (no `--state-db`). */
    private readonly database: Database | null = null,
  ) {}

  /**
   * Re-create every CP recorded in the `charge_points` table. Called once
   * at daemon start (before any CLI bootstrap / HTTP create) so a restart
   * with the same --state-db comes back with all the operator's
   * previously-registered CPs.
   *
   * Each restored CP is also auto-connected to its CSMS — otherwise the
   * CSMS would see the CP as gone after the restart (no BootNotification,
   * no StatusNotification). connect() throws nothing; the WebSocket
   * layer takes care of retry/backoff if the CSMS is briefly down.
   *
   * Idempotent: rows with cp_ids we've already instantiated are skipped.
   * Returns the list of restored cpIds for logging.
   */
  restoreFromDatabase(): string[] {
    if (!this.database) return [];
    const rows = this.database.all<ChargePointRow>(
      "SELECT cp_id, ws_url, connectors, vendor, model, basic_auth, boot_notif, created_at " +
        "FROM charge_points ORDER BY created_at ASC",
    );
    const restored: string[] = [];
    for (const row of rows) {
      if (this.services.has(row.cp_id)) continue;
      const init: ChargePointInitOptions = {
        cpId: row.cp_id,
        wsUrl: row.ws_url,
        connectors: row.connectors,
        vendor: row.vendor,
        model: row.model,
        basicAuth: safeJsonParse<ChargePointInitOptions["basicAuth"]>(
          row.basic_auth,
        ),
        bootNotification:
          safeJsonParse<ChargePointInitOptions["bootNotification"]>(
            row.boot_notif,
          ) ?? undefined,
      };
      // Use the internal create path WITHOUT re-inserting into the DB —
      // these rows already exist.
      const svc = this.instantiate(init);
      // Rehydrate every scenario the operator had loaded against this CP
      // before the restart. statusChange-trigger scenarios re-arm via the
      // connector subscription set up in CLIChargePointService — nothing
      // to do here beyond loading them.
      const restoredScenarios = svc.restoreScenariosFromDatabase();
      if (restoredScenarios > 0) {
        console.log(
          `[CPRegistry] Restored ${restoredScenarios} scenario(s) for CP "${row.cp_id}"`,
        );
      }
      // Kick the WebSocket open so BootNotification + StatusNotification
      // fly to the CSMS automatically. Fire-and-forget — connect() is
      // synchronous from JS's POV (returns immediately, opens in
      // background), and we don't want one slow CSMS to block restore of
      // the others.
      svc.connect().catch((err) => {
        // eslint-disable-next-line no-console
        console.error(
          `[CPRegistry] auto-connect failed for restored CP "${row.cp_id}":`,
          err,
        );
      });
      restored.push(row.cp_id);
    }
    return restored;
  }

  has(cpId: string): boolean {
    return this.services.has(cpId);
  }

  get(cpId: string): CLIChargePointService | undefined {
    return this.services.get(cpId);
  }

  list(): ReadonlyArray<string> {
    return [...this.services.keys()];
  }

  create(init: ChargePointInitOptions): CLIChargePointService {
    if (this.services.has(init.cpId)) {
      throw new Error(`cpId already exists: ${init.cpId}`);
    }
    this.persistCreate(init);
    return this.instantiate(init);
  }

  /** Construct + register the in-memory CLIChargePointService without
   *  touching the DB. Used by both create() (after DB insert) and
   *  restoreFromDatabase() (DB row already exists). */
  private instantiate(init: ChargePointInitOptions): CLIChargePointService {
    const svc = new CLIChargePointService(init, this.database);
    const unsub = svc.onEvent((evt) => this.bus.publish(init.cpId, evt));
    this.services.set(init.cpId, svc);
    this.unsubscribes.set(init.cpId, unsub);
    return svc;
  }

  private persistCreate(init: ChargePointInitOptions): void {
    if (!this.database) return;
    this.database.run(
      "INSERT INTO charge_points " +
        "(cp_id, ws_url, connectors, vendor, model, basic_auth, boot_notif, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (cp_id) DO UPDATE SET " +
        "ws_url = excluded.ws_url, connectors = excluded.connectors, " +
        "vendor = excluded.vendor, model = excluded.model, " +
        "basic_auth = excluded.basic_auth, boot_notif = excluded.boot_notif",
      [
        init.cpId,
        init.wsUrl,
        init.connectors,
        init.vendor,
        init.model,
        init.basicAuth ? JSON.stringify(init.basicAuth) : null,
        init.bootNotification ? JSON.stringify(init.bootNotification) : null,
        new Date().toISOString(),
      ],
    );
  }

  private persistRemove(cpId: string): void {
    if (!this.database) return;
    this.database.run("DELETE FROM charge_points WHERE cp_id = ?", [cpId]);
    // Cascade: orphan scenario rows would survive a CP delete and reappear
    // if the same cpId is re-created. There's no FK in the schema, so the
    // cleanup is explicit.
    this.database.run("DELETE FROM scenarios WHERE cp_id = ?", [cpId]);
  }

  remove(cpId: string): boolean {
    const svc = this.services.get(cpId);
    if (!svc) return false;
    svc.cleanup();
    this.unsubscribes.get(cpId)?.();
    this.unsubscribes.delete(cpId);
    this.services.delete(cpId);
    // Operator-initiated removal: drop the persisted row too. Process
    // shutdown goes through shutdownAll() instead and intentionally
    // leaves rows so restart restores them.
    this.persistRemove(cpId);
    return true;
  }

  shutdownAll(): void {
    for (const [cpId, svc] of this.services) {
      svc.cleanup();
      this.unsubscribes.get(cpId)?.();
    }
    this.services.clear();
    this.unsubscribes.clear();
  }
}

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
