import * as fs from "fs";

import { CLIChargePointService } from "../service";
import type { ChargePointInitOptions } from "../types";
import type { EventBus } from "./eventBus";
import type { Database } from "../../cp/domain/persistence/Database";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
} from "../../cp/infrastructure/transport/wsUrlWithBasic";
import { tlsKeyPermissionWarning } from "../tlsKeyPermissions";

export type RegistryMembershipChange = "added" | "removed";

export interface RegistryMembershipEvent {
  readonly change: RegistryMembershipChange;
  readonly cpId: string;
  readonly service: CLIChargePointService;
}

export type RegistryMembershipSink = (event: RegistryMembershipEvent) => void;

interface ChargePointRow {
  cp_id: string;
  ws_url: string;
  connectors: number;
  vendor: string;
  model: string;
  ocpp_version: string | null;
  central_system_url: string | null;
  soap_callback_url: string | null;
  soap_path: string | null;
  security_profile: number | null;
  authorization_key: string | null;
  cpo_name: string | null;
  tls_ca_path: string | null;
  tls_cert_path: string | null;
  tls_key_path: string | null;
  basic_auth: string | null;
  boot_notif: string | null;
  created_at: string;
}

interface CPRegistryOptions {
  readonly allowInsecureTlsKeyPerms?: boolean;
}

export class CPRegistry {
  private readonly services = new Map<string, CLIChargePointService>();
  private readonly unsubscribes = new Map<string, () => void>();
  private readonly registrySinks = new Set<RegistryMembershipSink>();

  constructor(
    private readonly bus: EventBus,
    /** Shared daemon DB threaded into every CLIChargePointService we
     *  create. `null` keeps everything in-memory (no `--state-db`). */
    private readonly database: Database | null = null,
    private readonly options: CPRegistryOptions = {},
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
      "SELECT cp_id, ws_url, connectors, vendor, model, ocpp_version, " +
        "central_system_url, soap_callback_url, soap_path, " +
        "security_profile, authorization_key, cpo_name, " +
        "tls_ca_path, tls_cert_path, tls_key_path, " +
        "basic_auth, boot_notif, created_at " +
        "FROM charge_points ORDER BY created_at ASC",
    );
    const restored: string[] = [];
    for (const row of rows) {
      if (this.services.has(row.cp_id)) continue;
      const securityProfile = parsePersistedSecurityProfile(row);
      const init: ChargePointInitOptions = {
        cpId: row.cp_id,
        wsUrl: row.ws_url,
        connectors: row.connectors,
        vendor: row.vendor,
        model: row.model,
        ocppVersion: row.ocpp_version ?? "OCPP-1.6J",
        centralSystemUrl: row.central_system_url ?? row.ws_url,
        soapCallbackUrl: row.soap_callback_url ?? undefined,
        soapPath: row.soap_path ?? undefined,
        securityProfile,
        authorizationKey: row.authorization_key ?? undefined,
        cpoName: row.cpo_name ?? undefined,
        tls: this.restoreTlsFromPaths(row, securityProfile),
        tlsCaPath: row.tls_ca_path ?? undefined,
        tlsCertPath: row.tls_cert_path ?? undefined,
        tlsKeyPath: row.tls_key_path ?? undefined,
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
      // Restore per-connector runtime state (OCPP status, in-flight
      // transaction, meter, soc) BEFORE wiring the WebSocket so the
      // first StatusNotification we send carries the resumed status
      // rather than a fresh Available. The snapshot is applied via
      // Connector.restoreRuntimeSnapshot, which writes private fields
      // without emitting statusChange — so the listeners on the new
      // service won't trigger a duplicate persist or notification.
      const restoredConnectors = svc.restoreConnectorRuntimeFromDatabase();
      if (restoredConnectors > 0) {
        console.log(
          `[CPRegistry] Restored ${restoredConnectors} connector runtime ` +
            `snapshot(s) for CP "${row.cp_id}"`,
        );
      }
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

  onRegistryMembership(handler: RegistryMembershipSink): () => void {
    this.registrySinks.add(handler);
    return () => {
      this.registrySinks.delete(handler);
    };
  }

  /**
   * Create + register a brand-new CP. Pass `opts.seedDefault: false` to
   * skip the auto-seeded Essential CP Behavior template — used by the
   * CLI bootstrap path when the operator supplied their own --scenario /
   * --scenario-template / --scenario-template-file, so the two don't
   * race for the connector's auto-start slot.
   */
  create(
    init: ChargePointInitOptions,
    opts: { seedDefault?: boolean } = {},
  ): CLIChargePointService {
    if (this.services.has(init.cpId)) {
      throw new Error(`cpId already exists: ${init.cpId}`);
    }
    const preparedInit = this.prepareInit(init);
    this.persistCreate(preparedInit);
    const svc = this.instantiate(preparedInit);
    // Restore path (restoreFromDatabase) calls instantiate() directly and
    // skips this seed — that path rehydrates whatever scenarios the
    // operator had, so we don't override an explicitly-cleared slot with
    // the default after a daemon restart.
    if (opts.seedDefault !== false) {
      svc.seedDefaultScenarios("essential-cp-behavior");
    }
    this.notifyRegistryMembership({
      change: "added",
      cpId: preparedInit.cpId,
      service: svc,
    });
    return svc;
  }

  /**
   * Replace an existing CP's in-memory service with one built from `init`.
   * Used by the "edit CP" flow in the web console: the existing OCPP
   * WebSocket is closed (via cleanup), the persisted row is updated
   * in-place, and a fresh CLIChargePointService is constructed with the
   * new wsUrl / vendor / etc. Scenarios persisted under the same `cp_id`
   * survive because `persistRemove` is NOT called — we update the row,
   * we don't delete it. The caller is expected to follow up with
   * `svc.connect()` so the new config takes effect.
   */
  update(init: ChargePointInitOptions): CLIChargePointService {
    const existing = this.services.get(init.cpId);
    if (!existing) {
      throw new Error(`cpId not found: ${init.cpId}`);
    }
    const mergedInit = mergeSecuritySensitiveInit(existing.getInit(), init);
    const preparedInit = this.prepareInit(mergedInit);
    // Snapshot the existing in-memory scenarios BEFORE cleanup wipes
    // them. Without --state-db there's no `scenarios` table to rehydrate
    // from, so `restoreScenariosFromDatabase` returns 0 and the operator
    // loses every seeded / hand-loaded scenario each time they touch
    // the CP's Edit form. With --state-db, restoreScenariosFromDatabase
    // covers it too; the snapshot is still safe to feed in because
    // loadScenario is an upsert keyed on scenario.id.
    const scenarioSnapshot = existing.snapshotScenarios();
    existing.cleanup();
    this.unsubscribes.get(init.cpId)?.();
    this.unsubscribes.delete(init.cpId);
    this.services.delete(init.cpId);
    this.persistCreate(preparedInit); // ON CONFLICT UPDATE — leaves scenarios intact
    const svc = this.instantiate(preparedInit);
    // Re-attach scenarios that the previous instance had loaded so the
    // re-created service picks up the same set without the operator
    // having to reload them.
    svc.restoreScenariosFromDatabase();
    for (const { connectorId, definition } of scenarioSnapshot) {
      try {
        svc.loadScenario(connectorId, definition);
      } catch (err) {
        console.warn(
          `[CPRegistry] Failed to re-attach scenario ${definition.id} to ${preparedInit.cpId}/connector ${connectorId} during update:`,
          err,
        );
      }
    }
    return svc;
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

  private prepareInit(init: ChargePointInitOptions): ChargePointInitOptions {
    if (
      (init.securityProfile === 1 || init.securityProfile === 2) &&
      !init.authorizationKey
    ) {
      throw new Error(
        `securityProfile ${init.securityProfile} requires authorizationKey.`,
      );
    }
    if (
      init.securityProfile === 3 &&
      !(init.tls?.cert && init.tls?.key) &&
      !(init.tlsCertPath && init.tlsKeyPath)
    ) {
      throw new Error(
        "securityProfile 3 requires client certificate and key TLS material.",
      );
    }
    const tlsFromPaths = this.readTlsFromInitPaths(init);
    if (!tlsFromPaths) return init;
    return {
      ...init,
      tls: init.tls ? mergeTlsOptions(init.tls, tlsFromPaths) : tlsFromPaths,
    };
  }

  private readTlsFromInitPaths(
    init: ChargePointInitOptions,
  ): OcppTlsOptions | undefined {
    if (!init.tlsCaPath && !init.tlsCertPath && !init.tlsKeyPath) {
      return undefined;
    }
    return this.readTlsFromPaths({
      cpId: init.cpId,
      tlsCaPath: init.tlsCaPath ?? null,
      tlsCertPath: init.tlsCertPath ?? null,
      tlsKeyPath: init.tlsKeyPath ?? null,
    });
  }

  private persistCreate(init: ChargePointInitOptions): void {
    if (!this.database) return;
    this.database.run(
      "INSERT INTO charge_points " +
        "(cp_id, ws_url, connectors, vendor, model, ocpp_version, " +
        "central_system_url, soap_callback_url, soap_path, " +
        "security_profile, authorization_key, cpo_name, " +
        "tls_ca_path, tls_cert_path, tls_key_path, " +
        "basic_auth, boot_notif, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (cp_id) DO UPDATE SET " +
        "ws_url = excluded.ws_url, connectors = excluded.connectors, " +
        "vendor = excluded.vendor, model = excluded.model, " +
        "ocpp_version = excluded.ocpp_version, " +
        "central_system_url = excluded.central_system_url, " +
        "soap_callback_url = excluded.soap_callback_url, " +
        "soap_path = excluded.soap_path, " +
        "security_profile = excluded.security_profile, " +
        "authorization_key = excluded.authorization_key, " +
        "cpo_name = excluded.cpo_name, " +
        "tls_ca_path = excluded.tls_ca_path, " +
        "tls_cert_path = excluded.tls_cert_path, " +
        "tls_key_path = excluded.tls_key_path, " +
        "basic_auth = excluded.basic_auth, boot_notif = excluded.boot_notif",
      [
        init.cpId,
        init.wsUrl,
        init.connectors,
        init.vendor,
        init.model,
        init.ocppVersion ?? "OCPP-1.6J",
        init.centralSystemUrl ?? init.wsUrl,
        init.soapCallbackUrl ?? null,
        init.soapPath ?? null,
        init.securityProfile ?? null,
        init.authorizationKey ?? null,
        init.cpoName ?? null,
        init.tlsCaPath ?? null,
        init.tlsCertPath ?? null,
        init.tlsKeyPath ?? null,
        init.basicAuth ? JSON.stringify(init.basicAuth) : null,
        init.bootNotification ? JSON.stringify(init.bootNotification) : null,
        new Date().toISOString(),
      ],
    );
  }

  private restoreTlsFromPaths(
    row: ChargePointRow,
    securityProfile: OcppSecurityProfile | undefined,
  ): OcppTlsOptions | undefined {
    if (
      (securityProfile === 1 || securityProfile === 2) &&
      !row.authorization_key
    ) {
      throw new Error(
        `Refusing to restore CP "${row.cp_id}" with securityProfile ` +
          `${securityProfile}: authorizationKey is required.`,
      );
    }
    if (securityProfile === 3 && (!row.tls_cert_path || !row.tls_key_path)) {
      throw new Error(
        `Refusing to restore CP "${row.cp_id}" with securityProfile 3: ` +
          "tlsCertPath and tlsKeyPath are required for mTLS.",
      );
    }

    return this.readTlsFromPaths({
      cpId: row.cp_id,
      tlsCaPath: row.tls_ca_path,
      tlsCertPath: row.tls_cert_path,
      tlsKeyPath: row.tls_key_path,
    });
  }

  private readTlsFromPaths(paths: {
    readonly cpId: string;
    readonly tlsCaPath: string | null;
    readonly tlsCertPath: string | null;
    readonly tlsKeyPath: string | null;
  }): OcppTlsOptions | undefined {
    const tls: {
      ca?: string;
      cert?: string;
      key?: string;
    } = {};
    if (paths.tlsCaPath) {
      tls.ca = readRestoredPem(paths.cpId, "--tls-ca", paths.tlsCaPath);
    }
    if (paths.tlsCertPath) {
      tls.cert = readRestoredPem(paths.cpId, "--tls-cert", paths.tlsCertPath);
    }
    if (paths.tlsKeyPath) {
      const warning = tlsKeyPermissionWarning(paths.tlsKeyPath);
      if (warning && !this.options.allowInsecureTlsKeyPerms) {
        throw new Error(
          `Refusing to restore CP "${paths.cpId}": ${warning}. ` +
            "Restart the daemon with --insecure-tls-key-perms to override.",
        );
      }
      if (warning) {
        process.stderr.write(
          `[CPRegistry] Warning: ${warning}; proceeding because ` +
            "--insecure-tls-key-perms was passed.\n",
        );
      }
      tls.key = readRestoredPem(paths.cpId, "--tls-key", paths.tlsKeyPath);
    }
    return Object.keys(tls).length > 0 ? tls : undefined;
  }

  private persistRemove(cpId: string): void {
    if (!this.database) return;
    this.database.run("DELETE FROM charge_points WHERE cp_id = ?", [cpId]);
    // Cascade: orphan rows in dependent tables would survive a CP delete
    // and reappear if the same cpId is re-created. There's no FK in the
    // schema, so the cleanup is explicit.
    this.database.run("DELETE FROM scenarios WHERE cp_id = ?", [cpId]);
    this.database.run("DELETE FROM connector_runtime WHERE cp_id = ?", [cpId]);
  }

  remove(cpId: string, opts: { notify?: boolean } = {}): boolean {
    const svc = this.services.get(cpId);
    if (!svc) return false;
    // Detach the CP from the EventBus and the registry map BEFORE cleanup().
    // cleanup() synchronously fires teardown statusChange events; if the CP
    // were still subscribed/registered, the registry bridge would emit a
    // `cp.updated` AFTER `cp.removed`, resurrecting the deleted CP in the UI.
    this.unsubscribes.get(cpId)?.();
    this.unsubscribes.delete(cpId);
    this.services.delete(cpId);
    if (opts.notify !== false) {
      this.notifyRegistryMembership({ change: "removed", cpId, service: svc });
    }
    svc.cleanup();
    // Operator-initiated removal: drop the persisted row too. Process
    // shutdown goes through shutdownAll() instead and intentionally
    // leaves rows so restart restores them.
    this.persistRemove(cpId);
    return true;
  }

  shutdownAll(): void {
    // Detach every CP from the EventBus + registry BEFORE cleanup(), so the
    // teardown statusChange events can't produce post-removal `cp.updated`
    // pushes (same hazard as remove()).
    const entries = [...this.services];
    for (const [cpId] of entries) {
      this.unsubscribes.get(cpId)?.();
    }
    this.unsubscribes.clear();
    this.services.clear();
    for (const [, svc] of entries) {
      svc.cleanup();
    }
  }

  private notifyRegistryMembership(event: RegistryMembershipEvent): void {
    for (const sink of this.registrySinks) {
      try {
        sink(event);
      } catch {
        process.stderr.write("[CPRegistry] registry membership sink error\n");
      }
    }
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

function parsePersistedSecurityProfile(
  row: ChargePointRow,
): OcppSecurityProfile | undefined {
  if (row.security_profile === null) return undefined;
  if (
    row.security_profile === 0 ||
    row.security_profile === 1 ||
    row.security_profile === 2 ||
    row.security_profile === 3
  ) {
    return row.security_profile;
  }
  throw new Error(
    `Refusing to restore CP "${row.cp_id}": invalid securityProfile ` +
      `${row.security_profile}.`,
  );
}

function readRestoredPem(cpId: string, flag: string, filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `Refusing to restore CP "${cpId}": failed to read ${flag} file ` +
        `'${filePath}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function mergeSecuritySensitiveInit(
  existing: ChargePointInitOptions,
  next: ChargePointInitOptions,
): ChargePointInitOptions {
  return {
    ...next,
    securityProfile: next.securityProfile ?? existing.securityProfile,
    authorizationKey: next.authorizationKey ?? existing.authorizationKey,
    cpoName: next.cpoName ?? existing.cpoName,
    tls:
      next.tls === undefined
        ? existing.tls
        : mergeTlsOptions(existing.tls, next.tls),
    tlsCaPath: next.tlsCaPath ?? existing.tlsCaPath,
    tlsCertPath: next.tlsCertPath ?? existing.tlsCertPath,
    tlsKeyPath: next.tlsKeyPath ?? existing.tlsKeyPath,
  };
}

function mergeTlsOptions(
  existing: OcppTlsOptions | undefined,
  next: OcppTlsOptions,
): OcppTlsOptions {
  return {
    ...(existing ?? {}),
    ...next,
  };
}
