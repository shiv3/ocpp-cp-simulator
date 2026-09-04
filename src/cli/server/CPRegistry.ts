import * as fs from "fs";

import { CLIChargePointService } from "../service";
import type { SessionSettledInfo } from "../service";
import type { ChargePointInitOptions } from "../types";
import type { AutoTrafficConfig } from "../../cp/domain/connector/AutoTraffic";
import type { EventBus } from "./eventBus";
import type { Database } from "../../cp/domain/persistence/Database";
import type { NetworkSimManager } from "./NetworkSimManager";
import { OcppSecurityProfileConfigError } from "../../cp/infrastructure/transport/wsUrlWithBasic";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
} from "../../cp/infrastructure/transport/wsUrlWithBasic";
import { tlsKeyPermissionWarning } from "../tlsKeyPermissions";
import { forgetWatchedChargePointFiles } from "./watchedScenarioFiles";

export type RegistryMembershipChange = "added" | "removed";

export interface RegistryMembershipEvent {
  readonly change: RegistryMembershipChange;
  readonly cpId: string;
  readonly service: CLIChargePointService;
}

export type RegistryMembershipSink = (event: RegistryMembershipEvent) => void;

/** #314: "something that could hold a reload back on this charge point has
 *  actually cleared" — a scenario run wound up, or a transaction was dropped. */
export type SessionSettledSink = (
  cpId: string,
  info: SessionSettledInfo,
) => void;

interface ChargePointRow {
  cp_id: string;
  ws_url: string;
  supervision_urls: string | null;
  url_distribution: string | null;
  id_tags: string | null;
  id_tag_distribution: string | null;
  id_tag_file: string | null;
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
  /** #314: fired whenever the set of live charge points, or the init options
   *  behind one, changes. `--watch` uses it to keep its watched-file set in
   *  step without every mutation path having to know the watcher exists. */
  private readonly initChangeSinks = new Set<() => void>();
  /** #314: fan-in of every live service's `onSessionSettled`, so a fleet-wide
   *  listener subscribes once instead of tracking memberships. */
  private readonly runSettledSinks = new Set<SessionSettledSink>();
  private networkSimManager: NetworkSimManager | null = null;

  constructor(
    private readonly bus: EventBus,
    /** Shared daemon DB threaded into every CLIChargePointService we
     *  create. `null` keeps everything in-memory (no `--state-db`). */
    private readonly database: Database | null = null,
    private readonly options: CPRegistryOptions = {},
    /**
     * Optional so every existing caller keeps working; when present, a
     * restored charge point resumes the background traffic it was configured
     * with (#300).
     */
    private readonly connectorSettingsRepository?: {
      loadAutoTrafficConfig(
        cpId: string,
        connectorId: number,
      ): Promise<AutoTrafficConfig | null>;
    },
  ) {}

  setNetworkSimManager(manager: NetworkSimManager): void {
    this.networkSimManager = manager;
  }

  getNetworkSimManager(): NetworkSimManager {
    if (!this.networkSimManager) {
      throw new Error("NetworkSimManager not initialized");
    }
    return this.networkSimManager;
  }

  /** Get all live WebSocket (non-SOAP) CP IDs. Used by NetworkSimManager
   *  to filter which CPs get fan-out config updates. */
  liveWsCpIds(): string[] {
    return [...this.services.values()]
      .filter((svc) => !svc.isSoapChargePoint())
      .map((svc) => svc.getInit().cpId);
  }

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
      "SELECT cp_id, ws_url, supervision_urls, url_distribution, " +
        "id_tags, id_tag_distribution, id_tag_file, " +
        "connectors, vendor, model, ocpp_version, " +
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
      // #296: without these the charge point comes back with failover
      // silently disabled — the one thing a URL list exists to provide.
      const supervisionUrls = safeJsonParse<string[]>(row.supervision_urls);
      // #299: without these a charge point created with an idTag pool came
      // back drawing nothing, silently falling back to the hard-coded literal.
      const idTags = safeJsonParse<string[]>(row.id_tags);
      const init: ChargePointInitOptions = {
        cpId: row.cp_id,
        wsUrl: row.ws_url,
        ...(supervisionUrls && supervisionUrls.length > 1
          ? { supervisionUrls }
          : {}),
        ...(row.url_distribution
          ? {
              urlDistribution: row.url_distribution as NonNullable<
                ChargePointInitOptions["urlDistribution"]
              >,
            }
          : {}),
        ...(idTags && idTags.length > 0 ? { idTags } : {}),
        // #314: the source path comes back too, so a daemon restarted with
        // --watch re-watches the file instead of holding a snapshot of it.
        ...(row.id_tag_file ? { idTagFile: row.id_tag_file } : {}),
        ...(row.id_tag_distribution
          ? {
              idTagDistribution: row.id_tag_distribution as NonNullable<
                ChargePointInitOptions["idTagDistribution"]
              >,
            }
          : {}),
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
      // #300: the traffic config lives in `connector_settings`, not the
      // connector row, so it needs its own restore. Without it an enabled
      // configuration survived the restart as a row and came back idle.
      if (this.connectorSettingsRepository) {
        void svc
          .restoreAutoTrafficFromDatabase(this.connectorSettingsRepository)
          .then((started) => {
            if (started > 0) {
              console.log(
                `[CPRegistry] Resumed background traffic on ${started} ` +
                  `connector(s) for CP "${row.cp_id}"`,
              );
            }
          })
          .catch(() => undefined);
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
      // Attach network simulation config BEFORE connecting so the CP
      // starts with its faults applied.
      if (this.networkSimManager) {
        this.networkSimManager.onCpCreated(row.cp_id);
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
   * Subscribe to "the init options of some charge point changed" (#314).
   *
   * Deliberately separate from {@link onRegistryMembership}, which only ever
   * reports `added` / `removed`: `update()` replaces a charge point's whole
   * init block — including `idTagFile` — without a membership change, so a
   * watcher driven by membership alone would keep watching the old file and
   * report success. The handler takes no argument; it is a "re-read me" ping,
   * and the subscriber walks the registry itself.
   */
  onInitChange(handler: () => void): () => void {
    this.initChangeSinks.add(handler);
    return () => {
      this.initChangeSinks.delete(handler);
    };
  }

  /**
   * Subscribe to "a reload gate has opened" across the whole fleet (#314).
   *
   * The bus's lifecycle events all announce the end of something from inside
   * the code that is ending it, while the state they announce is still set —
   * `scenario_completed` with the executor still registered,
   * `transaction_stopped` before the transaction is cleared — so none of them
   * can be used to decide that a charge point is free to be mutated. This
   * forwards each service's post-clear hook instead.
   */
  onSessionSettled(handler: SessionSettledSink): () => void {
    this.runSettledSinks.add(handler);
    return () => {
      this.runSettledSinks.delete(handler);
    };
  }

  private notifySessionSettled(cpId: string, info: SessionSettledInfo): void {
    for (const sink of this.runSettledSinks) {
      try {
        sink(cpId, info);
      } catch (err) {
        console.error(
          `[CPRegistry] session-settled sink error for "${cpId}":`,
          err,
        );
      }
    }
  }

  /**
   * Swap the idTag pool of a live charge point, and re-persist it (#314).
   *
   * Safe to apply mid-transaction, unlike a scenario reload: the pool is drawn
   * from once per session, so a transaction already under way keeps the tag it
   * started with and only the next draw sees the new list.
   *
   * Returns `false` when the charge point is gone or was created without a
   * pool at all — there is nothing to replace, and inventing one here would
   * make a `--watch` daemon behave differently from a plain `cp.create`.
   */
  applyIdTagReload(cpId: string, tags: readonly string[]): boolean {
    const svc = this.services.get(cpId);
    if (!svc) return false;
    // Asked without mutating, so the write below can come first.
    if (!svc.canReplaceIdTags(tags)) return false;
    // Persisted *before* the live pool is touched, deliberately (#314). The
    // caller reports the outcome of this call, so a write that throws
    // (SQLITE_BUSY, a full disk) must leave the daemon exactly as it was —
    // otherwise `rejected` is announced while the new tags are in force and a
    // restart quietly reverts them: the event, the running daemon and the
    // stored state would all disagree.
    //
    // Persist-first rather than mutate-then-roll-back on purpose. Both keep the
    // two in step at rest, but a rollback exposes a window in which a
    // concurrent draw can present a tag that is not durable; ordering it this
    // way means no reader ever sees one.
    this.database?.run("UPDATE charge_points SET id_tags = ? WHERE cp_id = ?", [
      JSON.stringify(tags),
      cpId,
    ]);
    return svc.replaceIdTags(tags);
  }

  /**
   * Attach an already-constructed single-CP service to the registry without
   * persisting, preparing, or seeding it. Standalone CLI mode uses this to
   * preserve the legacy `CLIChargePointService.fromOptions` bootstrap while
   * exposing that one CP through the RegistryChargePointService facade.
   */
  registerExisting(service: CLIChargePointService): CLIChargePointService {
    const init = service.getInit();
    if (this.services.has(init.cpId)) {
      throw new Error(`cpId already exists: ${init.cpId}`);
    }
    const unsub = service.onEvent((evt) => this.bus.publish(init.cpId, evt));
    const unsubSettled = service.onSessionSettled((info) =>
      this.notifySessionSettled(init.cpId, info),
    );
    this.services.set(init.cpId, service);
    this.unsubscribes.set(init.cpId, () => {
      unsub();
      unsubSettled();
    });
    this.notifyInitChange();
    this.notifyRegistryMembership({
      change: "added",
      cpId: init.cpId,
      service,
    });
    return service;
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
    // Attach network simulation config before seeding so scenarios
    // run with faults applied.
    if (this.networkSimManager) {
      this.networkSimManager.onCpCreated(preparedInit.cpId);
    }
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
    // Attach network simulation config so the re-created CP gets its faults.
    if (this.networkSimManager) {
      this.networkSimManager.onCpCreated(preparedInit.cpId);
    }
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
    // #314: `instantiate` already pinged, but that was *before* the scenarios
    // came back, so a subscriber that inspects them (the `--watch` drain) saw a
    // charge point with none. Ping again now the rebuild is actually complete;
    // `syncFromRegistry` is idempotent, so the extra ping costs nothing.
    this.notifyInitChange();
    return svc;
  }

  /** Construct + register the in-memory CLIChargePointService without
   *  touching the DB. Used by both create() (after DB insert) and
   *  restoreFromDatabase() (DB row already exists). */
  private instantiate(init: ChargePointInitOptions): CLIChargePointService {
    const svc = new CLIChargePointService(init, this.database);
    const unsub = svc.onEvent((evt) => this.bus.publish(init.cpId, evt));
    const unsubSettled = svc.onSessionSettled((info) =>
      this.notifySessionSettled(init.cpId, info),
    );
    this.services.set(init.cpId, svc);
    this.unsubscribes.set(init.cpId, () => {
      unsub();
      unsubSettled();
    });
    // The single choke point for "a service now exists under this init" —
    // create(), update() and restoreFromDatabase() all land here.
    this.notifyInitChange();
    return svc;
  }

  /**
   * Validate config-dependent security-profile requirements eagerly, before
   * create()/update() persist or mutate anything, so a bad request fails
   * atomically. Thrown as OcppSecurityProfileConfigError (rather than a
   * plain Error) so the RPC layer (socketServer.ts runFacadeOperation) can
   * map it to `invalid_params` with the human-readable message intact,
   * instead of it falling through to an opaque, unlogged "internal error".
   */
  private prepareInit(init: ChargePointInitOptions): ChargePointInitOptions {
    if (
      (init.securityProfile === 1 || init.securityProfile === 2) &&
      !init.authorizationKey
    ) {
      throw new OcppSecurityProfileConfigError(
        `securityProfile ${init.securityProfile} requires authorizationKey.`,
      );
    }
    if (
      init.securityProfile === 3 &&
      !(init.tls?.cert && init.tls?.key) &&
      !(init.tlsCertPath && init.tlsKeyPath)
    ) {
      throw new OcppSecurityProfileConfigError(
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
        "(cp_id, ws_url, supervision_urls, url_distribution, " +
        "id_tags, id_tag_distribution, id_tag_file, " +
        "connectors, vendor, model, ocpp_version, " +
        "central_system_url, soap_callback_url, soap_path, " +
        "security_profile, authorization_key, cpo_name, " +
        "tls_ca_path, tls_cert_path, tls_key_path, " +
        "basic_auth, boot_notif, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (cp_id) DO UPDATE SET " +
        "ws_url = excluded.ws_url, " +
        "supervision_urls = excluded.supervision_urls, " +
        "url_distribution = excluded.url_distribution, " +
        "id_tags = excluded.id_tags, " +
        "id_tag_distribution = excluded.id_tag_distribution, " +
        "id_tag_file = excluded.id_tag_file, " +
        "connectors = excluded.connectors, " +
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
        init.supervisionUrls ? JSON.stringify(init.supervisionUrls) : null,
        init.urlDistribution ?? null,
        init.idTags ? JSON.stringify(init.idTags) : null,
        init.idTagDistribution ?? null,
        init.idTagFile ?? null,
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
    // #314: the watch rows are stored state like the rest, so they go with the
    // charge point whether or not this daemon was started with `--watch`.
    forgetWatchedChargePointFiles(this.database, cpId);
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
    // Permanent deletion: use dispose() to cancel controller timers.
    svc.cleanup(true);
    // Drop from network sim config store.
    if (this.networkSimManager) {
      this.networkSimManager.onCpDeleted(cpId);
    }
    // Operator-initiated removal: drop the persisted row too. Process
    // shutdown goes through shutdownAll() instead and intentionally
    // leaves rows so restart restores them.
    this.persistRemove(cpId);
    this.notifyInitChange();
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
    this.notifyInitChange();
  }

  private notifyInitChange(): void {
    for (const sink of this.initChangeSinks) {
      try {
        sink();
      } catch {
        process.stderr.write("[CPRegistry] init change sink error\n");
      }
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
      { cause: err },
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
