import * as fs from "fs";

import type { ChargePointCapabilityProfile } from "@ocpp-cp-sim/core/cp/domain/charge-point/CapabilityProfile";
import { CLIChargePointService } from "../service";
import type { SessionSettledInfo } from "../service";
import type { Behavior, JsonObject } from "@ocpp-cp-sim/contracts/behavior";
import {
  behaviorFitProblem,
  behaviorShapeProblem,
} from "@ocpp-cp-sim/core/cp/application/engine/behaviorFit";
import {
  BehaviorLibrary,
  BehaviorNotLoadableError,
  type ReplaceOutcome,
} from "../behavior/BehaviorLibrary";
import type { ChargePointInitOptions } from "../types";
import type { AutoTrafficConfig } from "@ocpp-cp-sim/core/cp/domain/connector/AutoTraffic";
import type { EventBus } from "./eventBus";
import type { Database } from "@ocpp-cp-sim/core/cp/domain/persistence/Database";
import type { NetworkSimManager } from "./NetworkSimManager";
import { OcppSecurityProfileConfigError } from "@ocpp-cp-sim/core/cp/infrastructure/transport/wsUrlWithBasic";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
} from "@ocpp-cp-sim/core/cp/infrastructure/transport/wsUrlWithBasic";
import { tlsKeyPermissionWarning } from "../tlsKeyPermissions";
import { buildSoapCallbackUrl } from "../soapCallbackUrl";
import { DEFAULT_SOAP_PATH } from "../soapPath";
import { isSoapVersion } from "@ocpp-cp-sim/core/cp/domain/types/OcppVersion";
import { perChargePointTables } from "@ocpp-cp-sim/core/cp/domain/persistence/schema";
import { buildUpsert } from "@ocpp-cp-sim/core/cp/domain/persistence/upsert";
import {
  labelsSchema,
  matchesLabelSelector,
  normalizeLabels,
  type Labels,
} from "@ocpp-cp-sim/contracts/labels";
import { transportConfigSchema } from "@ocpp-cp-sim/contracts/transportConfig";
import type { ScenarioRunRepository } from "@ocpp-cp-sim/core/cp/domain/persistence/ScenarioRunRepository";
import { createScenarioRunRepository } from "@ocpp-cp-sim/core/cp/domain/persistence/createScenarioRunRepository";
import type { ChargingSessionRepository } from "@ocpp-cp-sim/core/cp/domain/persistence/ChargingSessionRepository";
import { createChargingSessionRepository } from "@ocpp-cp-sim/core/cp/domain/persistence/createChargingSessionRepository";
import {
  InMemoryScenarioRepository,
  type ScenarioRepository,
} from "@ocpp-cp-sim/core/cp/domain/persistence/ScenarioRepository";
import { createScenarioRepository } from "@ocpp-cp-sim/core/cp/domain/persistence/createScenarioRepository";

/**
 * `updated`: a registered charge point's config changed — rebuilt by
 * `update()`, or relabelled in place by `setLabels` (#446). Without it a
 * subscriber only learnt of a config change when the status happened to move,
 * so a list kept showing the old labels of a charge point that stayed offline.
 */
export type RegistryMembershipChange = "added" | "removed" | "updated";

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
  labels: string | null;
  behaviors: string | null;
  behavior_params: string | null;
  tx_updated_meter_values: number | null;
  inbound_validation: string | null;
  capability_profile: string | null;
  transport_options: string | null;
}

interface CPRegistryOptions {
  readonly allowInsecureTlsKeyPerms?: boolean;
  /**
   * Daemon-wide SOAP public base (`--soap-public-base-url`, or the origin of
   * the `--soap-tunnel`). A SOAP charge point instantiated without a callback
   * URL gets one derived from it — see ChargePointInitOptions.soapCallbackUrlDerived.
   */
  readonly soapPublicBaseUrl?: string | null;
  /** Default `<soapPath>` for that derivation; a charge point's own wins. */
  readonly soapPath?: string;
  /**
   * The behaviors (`--behavior`) this registry's charge points select from,
   * by id. A charge point without a `behaviors` list runs all of them, in
   * load order. The same module instance serves every charge point; a
   * behavior keeps its state in `ctx.state`, never at module scope.
   */
  readonly behaviors?: BehaviorLibrary | readonly Behavior[];
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
  /** #388: one run history for the whole daemon, so `scenario.runs.list` can
   *  span charge points without `--state-db` too. */
  readonly scenarioRuns: ScenarioRunRepository;
  /** #447: one session history for the whole daemon, so it outlives a
   *  `cp.update` rebuild without `--state-db` too. */
  readonly chargingSessions: ChargingSessionRepository;
  /** #495: one scenario-definition store for the whole daemon, read by the
   *  RPC layer and written by every charge point, so a definition saved over
   *  RPC (the Library included) or loaded by a charge point is there to read
   *  back without `--state-db` too. */
  readonly scenarioDefinitions: ScenarioRepository;
  /** The loaded behaviors; a charge point selects from it by id. */
  readonly library: BehaviorLibrary;
  /**
   * The `behaviors` column of a restored row whose in-memory selection is
   * smaller than what is stored (an id this run did not load, a behavior the
   * station cannot run). A rebuild that does not name a selection writes this
   * back, so a run with fewer files does not shrink the stored selection.
   */
  private readonly storedSelection = new Map<string, string | null>();
  /**
   * The raw `behavior_params` column of the same rows, kept and written back
   * under the same rule as {@link storedSelection}: the params of a behavior
   * this run did not load are not lost with the selection that names it.
   */
  private readonly storedParams = new Map<string, string | null>();

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
  ) {
    this.library =
      options.behaviors instanceof BehaviorLibrary
        ? options.behaviors
        : BehaviorLibrary.of(options.behaviors ?? []);
    this.library.onReplace((behaviors) =>
      this.replaceBehaviorsEverywhere(behaviors),
    );
    this.scenarioRuns = createScenarioRunRepository(database);
    this.chargingSessions = createChargingSessionRepository(database);
    this.scenarioDefinitions = createScenarioRepository(database);
  }

  /** `state.reset` without `--state-db`: drop the in-memory definitions,
   *  Library included, as `resetSimulatorState` empties the table. */
  clearScenarioDefinitions(): void {
    if (this.scenarioDefinitions instanceof InMemoryScenarioRepository) {
      this.scenarioDefinitions.clear();
    }
  }

  /** True when a SOAP charge point may be created without a callback URL. */
  canDeriveSoapCallbackUrl(): boolean {
    return Boolean(this.options.soapPublicBaseUrl);
  }

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
  /**
   * Re-create every persisted charge point.
   *
   * `opts.connect` defaults to true, which is what every caller but the daemon
   * bootstrap wants. The bootstrap passes `false` and dials separately with
   * {@link connectRestored}, because a restored charge point's persisted
   * connect-triggered scenarios auto-start as soon as its boot gate opens — and
   * if `--watch` has not re-established that scenario's watch by then, the
   * charge point runs the graph as it was when the daemon stopped rather than
   * as the file reads now, with the reload deferred behind the stale run it
   * just started (#314).
   */
  restoreFromDatabase(opts: { connect?: boolean } = {}): string[] {
    if (!this.database) return [];
    const rows = this.database.all<ChargePointRow>(
      "SELECT cp_id, ws_url, supervision_urls, url_distribution, " +
        "id_tags, id_tag_distribution, id_tag_file, " +
        "connectors, vendor, model, ocpp_version, " +
        "central_system_url, soap_callback_url, soap_path, " +
        "security_profile, authorization_key, cpo_name, " +
        "tls_ca_path, tls_cert_path, tls_key_path, " +
        "basic_auth, boot_notif, created_at, labels, behaviors, behavior_params, tx_updated_meter_values, " +
        "inbound_validation, capability_profile, transport_options " +
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
      const restored_behaviors = restoreBehaviors(
        row,
        this.library,
        row.ocpp_version ?? "OCPP-1.6J",
      );
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
        labels: restoreLabels(row),
        ...restored_behaviors.init,
        ...restoreBehaviorParams(
          row,
          this.library,
          restored_behaviors.init.behaviors,
        ),
        // #347: NULL — off, or a row older than the column — restores as off.
        ...(row.tx_updated_meter_values === 1
          ? { txUpdatedMeterValues: true }
          : {}),
        // #593: NULL, or a value this build does not know, restores as the
        // default (warn).
        ...(row.inbound_validation === "off" ||
        row.inbound_validation === "warn" ||
        row.inbound_validation === "enforce"
          ? { inboundValidation: row.inbound_validation }
          : {}),
        // #609: NULL restores the built-in behaviour.
        ...restoreTransport(row),
        // #618: NULL, or JSON this build cannot read, restores as no profile.
        ...restoreCapabilityProfile(row.capability_profile),
      };
      // #354 follow-up: a SOAP charge point whose callback URL was derived
      // from a base the daemon no longer has — the tunnel was not opened this
      // run, or --soap-public-base-url was dropped — cannot be constructed:
      // CLIChargePointService refuses a SOAP init with no callback URL. Left
      // to throw, that one row took the whole restore down and the daemon
      // with it, healthy WebSocket rows included. Skip the row and say why;
      // it stays in the table, so it comes back the moment the daemon is
      // started with a base again (or is updated with an explicit URL).
      if (
        isSoapVersion(init.ocppVersion) &&
        !init.soapCallbackUrl &&
        !this.canDeriveSoapCallbackUrl()
      ) {
        console.warn(
          `[CPRegistry] Skipping restore of SOAP charge point "${row.cp_id}": ` +
            "it has no callback URL and the daemon has no SOAP public base to " +
            "derive one from. Start with --soap-tunnel ngrok or " +
            "--soap-public-base-url <url> to bring it back, or give it an " +
            "explicit soapCallbackUrl with cp.update.",
        );
        continue;
      }
      // Use the internal create path WITHOUT re-inserting into the DB —
      // these rows already exist.
      try {
        const svc = this.instantiate(init, { reconcileSessions: false });
        if (restored_behaviors.column !== undefined) {
          this.storedSelection.set(row.cp_id, restored_behaviors.column);
          this.storedParams.set(row.cp_id, row.behavior_params ?? null);
        }
        // Restore per-connector runtime state (OCPP status, in-flight
        // transaction, meter, soc) BEFORE wiring the WebSocket so the
        // first StatusNotification we send carries the resumed status
        // rather than a fresh Available. The snapshot is applied via
        // Connector.restoreRuntimeSnapshot, which writes private fields
        // without emitting statusChange — so the listeners on the new
        // service won't trigger a duplicate persist or notification.
        const restoredConnectors = svc.restoreConnectorRuntimeFromDatabase();
        // #447: after the restore, so a restored transaction keeps its session.
        svc.reconcileChargingSessions();
        // After the reconcile, which only reads the connectors: `onResume` may
        // start a transaction, and it must see the restored sessions settled.
        svc.resumeEngine();
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
        restored.push(row.cp_id);
      } catch (error) {
        // One row that cannot be rebuilt is not the daemon's end: the others
        // come back, and this one stays in the table for a start that can.
        this.storedSelection.delete(row.cp_id);
        this.storedParams.delete(row.cp_id);
        // A step after `instantiate` failed: the service is registered but was
        // never wired. Take it out, or it sits in list() and never connects.
        const partial = this.services.get(row.cp_id);
        if (partial) {
          this.unsubscribes.get(row.cp_id)?.();
          this.unsubscribes.delete(row.cp_id);
          this.services.delete(row.cp_id);
          try {
            partial.cleanup(true);
          } catch {
            // The restore of this row is being given up anyway.
          }
        }
        console.warn(
          `[CPRegistry] Skipping restore of charge point "${row.cp_id}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    // Kick the WebSockets open so BootNotification + StatusNotification fly to
    // the CSMS automatically. Fire-and-forget — connect() returns immediately
    // and opens in the background, and we don't want one slow CSMS to block the
    // others. Deferred entirely when the caller says so, so it can put work
    // between rebuilding the fleet and letting it dial.
    if (opts.connect !== false) this.connectRestored(restored);
    return restored;
  }

  /**
   * Dial the charge points {@link restoreFromDatabase} rebuilt.
   *
   * Split out so the daemon can re-establish file watches first: the moment a
   * restored charge point's boot gate opens, a persisted connect-triggered
   * scenario starts, and it must start from the file as it reads now (#314).
   */
  connectRestored(cpIds: readonly string[]): void {
    for (const cpId of cpIds) {
      this.services
        .get(cpId)
        ?.connect()
        .catch((err) => {
          console.error(
            `[CPRegistry] auto-connect failed for restored CP "${cpId}":`,
            err,
          );
        });
    }
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

  /** #470: the ids whose labels match `selector`, read from each charge
   *  point's init so picking a group builds no status snapshot. */
  selectByLabels(selector: Labels | undefined): string[] {
    return [...this.services]
      .filter(([, svc]) => matchesLabelSelector(svc.getInit().labels, selector))
      .map(([cpId]) => cpId);
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
   * Deliberately separate from {@link onRegistryMembership}: that channel
   * carries the new service to wire subscribers, while this one only says
   * "re-read the inits". `update()` replaces a charge point's whole init block —
   * including `idTagFile` — and a watcher that missed it would keep watching
   * the old file and report success. The handler takes no argument; it is a "re-read me" ping,
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
   * Replace a charge point's labels in place (#446) — the relabel path that
   * does not rebuild it, unlike {@link update}: the connection, transactions
   * and scenarios are untouched. Persisted before the live service changes,
   * like `applyIdTagReload`, so a failed write leaves the daemon as it was.
   * Returns `false` when no such charge point is registered.
   */
  setLabels(cpId: string, labels: Labels): boolean {
    const svc = this.services.get(cpId);
    if (!svc) return false;
    this.database?.run("UPDATE charge_points SET labels = ? WHERE cp_id = ?", [
      labelsColumn(labels),
      cpId,
    ]);
    svc.setLabels(labels);
    this.notifyRegistryMembership({ change: "updated", cpId, service: svc });
    return true;
  }

  /**
   * Change which loaded behaviors a charge point runs, in place: the ones no
   * longer selected are unloaded, the newly selected ones are loaded after
   * those already running. `undefined` selects every loaded behavior. Persisted
   * before the live service changes. Throws {@link UnknownBehaviorError}
   * (naming the loaded ids) for an id that is not loaded, before anything
   * changes. Returns the ids the charge point runs now, or `null` when no such
   * charge point is registered.
   */
  setBehaviors(
    cpId: string,
    ids: readonly string[] | undefined,
    params?: Readonly<Record<string, JsonObject>>,
  ): string[] | null {
    const svc = this.services.get(cpId);
    if (!svc) return null;
    const wanted = this.library.select(ids);
    // Nothing is written until the station has shown it can run the selection:
    // the version checks first, then the params, then the live change, then
    // the row.
    this.checkFit(svc.getInit().ocppVersion, wanted);
    this.library.checkParams(wanted, params);
    svc.setBehaviors(wanted, ids, params);
    this.database?.run(
      "UPDATE charge_points SET behaviors = ?, behavior_params = ? WHERE cp_id = ?",
      [
        ids ? JSON.stringify(ids) : null,
        params && Object.keys(params).length > 0
          ? JSON.stringify(params)
          : null,
        cpId,
      ],
    );
    this.storedSelection.delete(cpId);
    this.storedParams.delete(cpId);
    this.notifyRegistryMembership({ change: "updated", cpId, service: svc });
    return svc.behaviorIds();
  }

  /** Throws {@link BehaviorNotLoadableError} for a behavior this version cannot run. */
  private checkFit(
    ocppVersion: string | undefined,
    behaviors: readonly Behavior[],
  ): void {
    for (const behavior of behaviors) {
      const problem = behaviorFitProblem(behavior, {
        ocppVersion: ocppVersion ?? "OCPP-1.6J",
      });
      if (problem) throw new BehaviorNotLoadableError(problem);
    }
  }

  /**
   * The library listener: put the reloaded behaviors of one file on every
   * charge point running them. All or none on each charge point: every new
   * version is checked first, and a failure part-way puts the old versions back.
   */
  private replaceBehaviorsEverywhere(
    behaviors: readonly Behavior[],
  ): ReplaceOutcome {
    let applied = 0;
    const failures: string[] = [];
    for (const [cpId, svc] of this.services) {
      const running = svc.behaviorIds();
      const mine = behaviors.filter((b) => running.includes(b.id));
      if (mine.length === 0) continue;
      try {
        svc.replaceBehaviors(mine);
        applied++;
      } catch (error) {
        failures.push(
          `${cpId} keeps the old version of ${mine.map((b) => b.id).join(", ")}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { applied, failures };
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
    // A removed station's stored selection does not follow its id.
    this.storedSelection.delete(init.cpId);
    this.storedParams.delete(init.cpId);
    this.persistCreate(preparedInit);
    let svc: CLIChargePointService;
    try {
      svc = this.instantiate(preparedInit);
    } catch (error) {
      // The row was written a line ago and this id did not exist: take it back.
      this.persistRemove(preparedInit.cpId);
      throw error;
    }
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
    const mergedInit = preserveOmittedInit(existing.getInit(), init);
    const preparedInit = this.prepareInit(mergedInit);
    // Snapshot the existing in-memory scenarios BEFORE cleanup wipes
    // them. Without --state-db there's no `scenarios` table to rehydrate
    // from, so `restoreScenariosFromDatabase` returns 0 and the operator
    // loses every seeded / hand-loaded scenario each time they touch
    // the CP's Edit form. With --state-db, restoreScenariosFromDatabase
    // covers it too; the snapshot is still safe to feed in because
    // loadScenario is an upsert keyed on scenario.id.
    const scenarioSnapshot = existing.snapshotScenarios();
    // Without a state database nothing else carries `ctx.state` across the
    // rebuild; with one, the new service reads it back from the row.
    const engineState = this.database
      ? undefined
      : existing.engineStateSnapshot();
    const previousInit = existing.getInit();
    const previousColumn = this.storedSelection.get(init.cpId);
    const previousParamsColumn = this.storedParams.get(init.cpId);
    // Find out before the old station is closed: a selection this engine
    // refuses must leave the station connected and as it was.
    existing.assertBehaviorsLoadable(
      this.library.select(preparedInit.behaviors),
    );
    existing.cleanup();
    this.unsubscribes.get(init.cpId)?.();
    this.unsubscribes.delete(init.cpId);
    this.services.delete(init.cpId);
    // A rebuild that does not name a selection keeps the stored one, even when
    // this run holds fewer behaviors than it lists.
    const keepStored =
      init.behaviors === undefined && previousColumn !== undefined;
    // The params follow the selection: kept from the row unless the request
    // names new ones.
    this.persistCreate(
      preparedInit,
      keepStored ? previousColumn : undefined,
      keepStored && init.behaviorParams === undefined
        ? previousParamsColumn
        : undefined,
    ); // ON CONFLICT UPDATE — leaves scenarios intact
    let svc: CLIChargePointService;
    try {
      svc = this.instantiate(preparedInit, { engineState });
    } catch (error) {
      // The new configuration cannot run: put the old station back, row and
      // service, rather than leave the id gone.
      // The SOAP callback URL the daemon derived is not the operator's: it
      // goes back to the row as absent, like on any other write (#183).
      const stored = previousInit.soapCallbackUrlDerived
        ? {
            ...previousInit,
            soapCallbackUrl: undefined,
            soapCallbackUrlDerived: undefined,
          }
        : previousInit;
      this.persistCreate(stored, previousColumn, previousParamsColumn);
      const back = this.instantiate(previousInit, { engineState });
      // Everything the success path restores: the old station comes back whole.
      this.networkSimManager?.onCpCreated(previousInit.cpId);
      back.restoreScenariosFromDatabase();
      for (const { connectorId, definition } of scenarioSnapshot) {
        try {
          back.loadScenario(connectorId, definition);
        } catch {
          // It loaded before; the original error is the one to report.
        }
      }
      throw error;
    }
    if (!keepStored) {
      this.storedSelection.delete(init.cpId);
      this.storedParams.delete(init.cpId);
    } else if (init.behaviorParams !== undefined) {
      this.storedParams.delete(init.cpId);
    }
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
    this.notifyRegistryMembership({
      change: "updated",
      cpId: preparedInit.cpId,
      service: svc,
    });
    return svc;
  }

  /** Construct + register the in-memory CLIChargePointService without
   *  touching the DB. Used by both create() (after DB insert) and
   *  restoreFromDatabase() (DB row already exists).
   *
   *  #447: the charging sessions a previous instance under this id left open
   *  are reconciled here, before anyone hears of the service — a `cp.update`
   *  rebuild drops the in-memory transactions, so they end up interrupted.
   *  The restore path opts out and reconciles once the connector runtime is
   *  back, so a restored transaction keeps its session. */
  private instantiate(
    init: ChargePointInitOptions,
    {
      reconcileSessions = true,
      engineState,
    }: {
      reconcileSessions?: boolean;
      engineState?: ReturnType<CLIChargePointService["engineStateSnapshot"]>;
    } = {},
  ): CLIChargePointService {
    const svc = new CLIChargePointService(
      this.withDerivedSoapCallback(init),
      this.database,
      this.scenarioRuns,
      this.chargingSessions,
      this.scenarioDefinitions,
    );
    const unsub = svc.onEvent((evt) => this.bus.publish(init.cpId, evt));
    const unsubSettled = svc.onSessionSettled((info) =>
      this.notifySessionSettled(init.cpId, info),
    );
    this.services.set(init.cpId, svc);
    this.unsubscribes.set(init.cpId, () => {
      unsub();
      unsubSettled();
    });
    if (engineState) svc.restoreEngineState(engineState);
    try {
      svc.loadBehaviors(
        this.library.select(init.behaviors),
        init.behaviorParams,
      );
    } catch (error) {
      // A station that cannot load its behaviors is not registered: no ghost
      // under the id, nothing for a later `list` or restart to trip over.
      this.unsubscribes.get(init.cpId)?.();
      this.unsubscribes.delete(init.cpId);
      this.services.delete(init.cpId);
      svc.cleanup();
      throw error;
    }
    if (reconcileSessions) svc.reconcileChargingSessions();
    // The single choke point for "a service now exists under this init" —
    // create(), update() and restoreFromDatabase() all land here.
    this.notifyInitChange();
    return svc;
  }

  /**
   * Fill in the SOAP callback URL from the daemon's public base when the
   * charge point has none. Done at instantiation — after create()/update()
   * have persisted the operator's own init — so the derived value never
   * reaches the DB row (a free-tier tunnel URL changes between runs) and a
   * restore re-derives it from whatever base the daemon has *now*.
   */
  private withDerivedSoapCallback(
    init: ChargePointInitOptions,
  ): ChargePointInitOptions {
    if (init.soapCallbackUrl) return init;
    const base = this.options.soapPublicBaseUrl;
    if (!base || !isSoapVersion(init.ocppVersion)) return init;
    return {
      ...init,
      soapCallbackUrl: buildSoapCallbackUrl(
        base,
        init.cpId,
        init.soapPath ?? this.options.soapPath ?? DEFAULT_SOAP_PATH,
      ),
      soapCallbackUrlDerived: true,
    };
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
    // Ids only: an id that names no loaded behavior is refused here, before
    // anything is persisted, with the loaded ids in the message.
    if (init.behaviors !== undefined) this.library.check(init.behaviors);
    const selected = this.library.select(init.behaviors);
    this.checkFit(init.ocppVersion, selected);
    this.library.checkParams(selected, init.behaviorParams);
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

  /**
   * `behaviorsColumn`, when given, is written as the `behaviors` value instead
   * of the init's own, `paramsColumn` likewise for `behavior_params` (see
   * {@link storedSelection}).
   */
  private persistCreate(
    init: ChargePointInitOptions,
    behaviorsColumn?: string | null,
    paramsColumn?: string | null,
  ): void {
    if (!this.database) return;
    const { sql, params } = buildUpsert(
      "charge_points",
      [
        ["cp_id", init.cpId],
        ["ws_url", init.wsUrl],
        [
          "supervision_urls",
          init.supervisionUrls ? JSON.stringify(init.supervisionUrls) : null,
        ],
        ["url_distribution", init.urlDistribution ?? null],
        ["id_tags", init.idTags ? JSON.stringify(init.idTags) : null],
        ["id_tag_distribution", init.idTagDistribution ?? null],
        ["id_tag_file", init.idTagFile ?? null],
        ["connectors", init.connectors],
        ["vendor", init.vendor],
        ["model", init.model],
        ["ocpp_version", init.ocppVersion ?? "OCPP-1.6J"],
        ["central_system_url", init.centralSystemUrl ?? init.wsUrl],
        ["soap_callback_url", init.soapCallbackUrl ?? null],
        ["soap_path", init.soapPath ?? null],
        ["security_profile", init.securityProfile ?? null],
        ["authorization_key", init.authorizationKey ?? null],
        ["cpo_name", init.cpoName ?? null],
        ["tls_ca_path", init.tlsCaPath ?? null],
        ["tls_cert_path", init.tlsCertPath ?? null],
        ["tls_key_path", init.tlsKeyPath ?? null],
        ["basic_auth", init.basicAuth ? JSON.stringify(init.basicAuth) : null],
        [
          "boot_notif",
          init.bootNotification ? JSON.stringify(init.bootNotification) : null,
        ],
        ["created_at", new Date().toISOString()],
        ["labels", labelsColumn(init.labels)],
        [
          "behaviors",
          behaviorsColumn !== undefined
            ? behaviorsColumn
            : init.behaviors
              ? JSON.stringify(init.behaviors)
              : null,
        ],
        [
          "behavior_params",
          paramsColumn !== undefined
            ? paramsColumn
            : init.behaviorParams && Object.keys(init.behaviorParams).length > 0
              ? JSON.stringify(init.behaviorParams)
              : null,
        ],
        ["tx_updated_meter_values", init.txUpdatedMeterValues ? 1 : null],
        ["inbound_validation", init.inboundValidation ?? null],
        [
          "capability_profile",
          init.capabilityProfile
            ? JSON.stringify(init.capabilityProfile)
            : null,
        ],
        [
          "transport_options",
          init.transport ? JSON.stringify(init.transport) : null,
        ],
      ],
      ["cp_id"],
      // The row keeps the time it was first created.
      ["created_at"],
    );
    this.database.run(sql, params);
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
    // Cascade to every `cp_id`-keyed table. There is no FK in the schema, so
    // the cleanup is explicit — and the list is the schema's own (#326):
    // hand-maintained here it covered three of the eight, and the rows left
    // behind (settings, profiles, configuration, queued CALLs, logs, the
    // desired-connected flag) came back when the same cpId was re-created.
    // #314's watch rows ride the same list, whether or not this daemon runs
    // with `--watch`.
    for (const table of perChargePointTables()) {
      try {
        this.database.run(`DELETE FROM ${table} WHERE cp_id = ?`, [cpId]);
      } catch (err) {
        // A DB from before a table existed: keep deleting the rest.
        console.warn(
          `[CPRegistry] could not delete ${cpId} rows from ${table}:`,
          err,
        );
      }
    }
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
    this.storedSelection.delete(cpId);
    this.storedParams.delete(cpId);
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
    // The in-memory histories have no table for persistRemove to cascade to.
    this.scenarioRuns.deleteForChargePoint(cpId);
    this.chargingSessions.deleteForChargePoint(cpId);
    if (this.scenarioDefinitions instanceof InMemoryScenarioRepository) {
      this.scenarioDefinitions.deleteForChargePoint(cpId);
    }
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

/** NULL for "no labels", the empty map included (see `normalizeLabels`). */
function labelsColumn(labels: Labels | undefined): string | null {
  const normalized = normalizeLabels(labels);
  return normalized ? JSON.stringify(normalized) : null;
}

/**
 * Read back through the wire schema rather than trusted: every list item and
 * registry push is validated against it, so one hand-edited or corrupted row
 * would otherwise fail every `cp.list` instead of losing its own labels.
 */
function restoreLabels(row: ChargePointRow): Labels | undefined {
  const raw = safeJsonParse<unknown>(row.labels);
  if (raw === null) return undefined;
  const parsed = labelsSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(
      `[CPRegistry] ignoring invalid stored labels for ${row.cp_id}`,
    );
    return undefined;
  }
  return parsed.data;
}

/**
 * #609: the stored transport settings, or nothing. A value that is not JSON or
 * fails the schema is dropped with a warning, so one damaged row does not stop
 * the restore: the charge point comes back with the built-in behaviour.
 */
function restoreTransport(
  row: ChargePointRow,
): Pick<ChargePointInitOptions, "transport"> {
  const raw = safeJsonParse<unknown>(row.transport_options);
  if (raw === null) return {};
  const parsed = transportConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(
      `[CPRegistry] ignoring invalid stored transport options for ${row.cp_id}`,
    );
    return {};
  }
  return { transport: parsed.data };
}

/**
 * Read the stored selection back, for a station that speaks `ocppVersion`.
 *
 * What this run cannot honor is left out of memory only: an id the library
 * does not have (the daemon was started with fewer `--behavior` files) and a
 * behavior the station cannot run are dropped with a warning, and the charge
 * point comes back without them. `column` is then the stored value as it is,
 * so a rebuild that does not name a selection writes it back instead of the
 * shorter list. A stored value that cannot be read selects nothing (and
 * says so): a station never runs every behavior because its row is damaged.
 */
function restoreBehaviors(
  row: ChargePointRow,
  library: BehaviorLibrary,
  ocppVersion: string,
): { init: { behaviors?: string[] }; column?: string | null } {
  const fits = (id: string): string | null => {
    const behavior = library.get(id);
    if (!behavior) return "is not loaded in this run";
    return (
      behaviorShapeProblem(behavior) ??
      behaviorFitProblem(behavior, { ocppVersion })
    );
  };
  const parsed = safeJsonParse<unknown>(row.behaviors);
  if (
    row.behaviors &&
    (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string"))
  ) {
    console.warn(
      `[CPRegistry] ${row.cp_id}: the stored behaviors cannot be read; the charge point runs none until a selection is set`,
    );
    return { init: { behaviors: [] }, column: row.behaviors };
  }
  const stored = parsed as string[] | null;
  const wanted = stored ?? library.ids();
  const kept: string[] = [];
  for (const id of wanted) {
    const problem = fits(id);
    if (problem === null) {
      kept.push(id);
    } else if (stored !== null || library.get(id) !== undefined) {
      console.warn(
        `[CPRegistry] ${row.cp_id}: behavior ${id} is left out: ${problem} (loaded: ${library.ids().join(", ") || "none"})`,
      );
    }
  }
  if (stored === null && kept.length === wanted.length) return { init: {} };
  if (stored !== null && kept.length === stored.length) {
    return { init: { behaviors: kept } };
  }
  return { init: { behaviors: kept }, column: row.behaviors };
}

/**
 * Read the stored behavior params back. Like the selection, what this run
 * cannot honor is left out of memory with a warning: an entry for a behavior
 * the station does not run, or one that no longer fits the schema of the
 * behavior (a reloaded file changed it). The station comes back with that
 * behavior on its defaults rather than not at all.
 */
function restoreBehaviorParams(
  row: ChargePointRow,
  library: BehaviorLibrary,
  selection: readonly string[] | undefined,
): { behaviorParams?: Record<string, JsonObject> } {
  const parsed = safeJsonParse<unknown>(row.behavior_params);
  if (parsed === null) {
    if (row.behavior_params) {
      console.warn(
        `[CPRegistry] ${row.cp_id}: the stored behavior params cannot be read; every behavior runs with its defaults`,
      );
    }
    return {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(
      `[CPRegistry] ${row.cp_id}: the stored behavior params cannot be read; every behavior runs with its defaults`,
    );
    return {};
  }
  const kept: Record<string, JsonObject> = {};
  const running = library.select(selection);
  for (const [id, set] of Object.entries(parsed as Record<string, unknown>)) {
    try {
      library.checkParams(running, { [id]: set as JsonObject });
      kept[id] = set as JsonObject;
    } catch (error) {
      console.warn(
        `[CPRegistry] ${row.cp_id}: the stored params of ${id} are left out: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return Object.keys(kept).length > 0 ? { behaviorParams: kept } : {};
}

function restoreCapabilityProfile(
  raw: string | null,
): { capabilityProfile: ChargePointCapabilityProfile } | Record<string, never> {
  const parsed = safeJsonParse<unknown>(raw);
  if (typeof parsed !== "object" || parsed === null) return {};
  const { disabledActions, triggerMessageTargets } = parsed as Record<
    string,
    unknown
  >;
  const names = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((v) => typeof v === "string")
      ? (value as string[])
      : undefined;
  const profile: {
    -readonly [
      K in keyof ChargePointCapabilityProfile
    ]: ChargePointCapabilityProfile[K];
  } = {};
  const disabled = names(disabledActions);
  const targets = names(triggerMessageTargets);
  if (disabled) profile.disabledActions = disabled;
  if (targets) profile.triggerMessageTargets = targets;
  return { capabilityProfile: profile };
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

/**
 * The fields an update keeps when it omits them: the security-sensitive ones a
 * redacted snapshot cannot send back, and the labels (#446) — an update that
 * does not mention them keeps them, `{}` clears them.
 */
function preserveOmittedInit(
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
    labels: next.labels ?? existing.labels,
    behaviors: next.behaviors ?? existing.behaviors,
    behaviorParams: next.behaviorParams ?? existing.behaviorParams,
    txUpdatedMeterValues:
      next.txUpdatedMeterValues ?? existing.txUpdatedMeterValues,
    inboundValidation: next.inboundValidation ?? existing.inboundValidation,
    transport: next.transport ?? existing.transport,
    capabilityProfile: next.capabilityProfile ?? existing.capabilityProfile,
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
