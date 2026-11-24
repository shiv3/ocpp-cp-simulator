import type { CLIChargePointService } from "../../service";
import type { ChargePointInitOptions } from "../../types";
import type { AutoTrafficConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/AutoTraffic";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import { isSoapVersion } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import type { BehaviorLibrary } from "../../behavior/BehaviorLibrary";
import type { NetworkSimManager } from "../NetworkSimManager";
import { restoreTlsFromPaths } from "./tlsPaths";
import {
  parsePersistedSecurityProfile,
  restoreBehaviorParams,
  restoreBehaviors,
  restoreCapabilityProfile,
  restoreChargerCapabilities,
  restoreLabels,
  restoreTransport,
  safeJsonParse,
  type ChargePointRow,
} from "./rowMapping";

/** What {@link restoreFromDatabase} needs from the registry that owns it. */
export interface RestoreContext {
  readonly database: Database | null;
  readonly library: BehaviorLibrary;
  readonly services: Map<string, CLIChargePointService>;
  readonly unsubscribes: Map<string, () => void>;
  readonly storedSelection: Map<string, string | null>;
  readonly storedParams: Map<string, string | null>;
  readonly options: { readonly allowInsecureTlsKeyPerms?: boolean };
  readonly connectorSettingsRepository?: {
    loadAutoTrafficConfig(
      cpId: string,
      connectorId: number,
    ): Promise<AutoTrafficConfig | null>;
  };
  /** A getter: the manager is attached after construction. */
  readonly networkSimManager: NetworkSimManager | null;
  canDeriveSoapCallbackUrl(): boolean;
  instantiate(
    init: ChargePointInitOptions,
    opts: { reconcileSessions?: boolean },
  ): CLIChargePointService;
  connectRestored(cpIds: readonly string[]): void;
}

/** Body of `CPRegistry.restoreFromDatabase` (see the JSDoc there). */
export function restoreFromDatabase(
  ctx: RestoreContext,
  opts: { connect?: boolean } = {},
): string[] {
  if (!ctx.database) return [];
  const rows = ctx.database.all<ChargePointRow>(
    "SELECT cp_id, ws_url, supervision_urls, url_distribution, " +
      "id_tags, id_tag_distribution, id_tag_file, " +
      "connectors, vendor, model, ocpp_version, " +
      "central_system_url, soap_callback_url, soap_path, " +
      "security_profile, authorization_key, cpo_name, " +
      "tls_ca_path, tls_cert_path, tls_key_path, " +
      "basic_auth, boot_notif, created_at, labels, behaviors, behavior_params, tx_updated_meter_values, " +
      "inbound_validation, capability_profile, charger_capabilities, " +
      "transport_options, reservation_authorize_id_tag, " +
      "meter_value_decimal_separator, empty_meter_values " +
      "FROM charge_points ORDER BY created_at ASC",
  );
  const restored: string[] = [];
  for (const row of rows) {
    if (ctx.services.has(row.cp_id)) continue;
    const securityProfile = parsePersistedSecurityProfile(row);
    // #296: without these the charge point comes back with failover
    // silently disabled — the one thing a URL list exists to provide.
    const supervisionUrls = safeJsonParse<string[]>(row.supervision_urls);
    // #299: without these a charge point created with an idTag pool came
    // back drawing nothing, silently falling back to the hard-coded literal.
    const idTags = safeJsonParse<string[]>(row.id_tags);
    const restored_behaviors = restoreBehaviors(
      row,
      ctx.library,
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
      tls: restoreTlsFromPaths(ctx.options, row, securityProfile),
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
        ctx.library,
        restored_behaviors.init.behaviors,
      ),
      // #551: 0 restores the opt-out; NULL (a row older than the default
      // flip, or one never set) and 1 restore as the default (on).
      ...(row.tx_updated_meter_values === 0
        ? { txUpdatedMeterValues: false }
        : row.tx_updated_meter_values === 1
          ? { txUpdatedMeterValues: true }
          : {}),
      // #593: NULL, or a value this build does not know, restores as the
      // default (warn).
      ...(row.inbound_validation === "off" ||
      row.inbound_validation === "warn" ||
      row.inbound_validation === "enforce"
        ? { inboundValidation: row.inbound_validation }
        : {}),
      // #595: NULL — off, or a row older than the column — restores as off.
      ...(row.reservation_authorize_id_tag === 1
        ? { reservationAuthorizeIdTag: true }
        : {}),
      // #1133 / #1134: NULL (or a row older than the columns) is the default.
      ...(row.meter_value_decimal_separator === ","
        ? { meterValueDecimalSeparator: "," as const }
        : {}),
      ...(row.empty_meter_values === 1 ? { emptyMeterValues: true } : {}),
      // #609: NULL restores the built-in behaviour.
      ...restoreTransport(row),
      // #618: NULL, or JSON this build cannot read, restores as no profile.
      ...restoreCapabilityProfile(row.capability_profile),
      // #327: NULL, or JSON this build cannot read, restores as no cap.
      ...restoreChargerCapabilities(row.charger_capabilities),
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
      !ctx.canDeriveSoapCallbackUrl()
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
      const svc = ctx.instantiate(init, { reconcileSessions: false });
      if (restored_behaviors.column !== undefined) {
        ctx.storedSelection.set(row.cp_id, restored_behaviors.column);
        ctx.storedParams.set(row.cp_id, row.behavior_params ?? null);
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
      if (ctx.connectorSettingsRepository) {
        void svc
          .restoreAutoTrafficFromDatabase(ctx.connectorSettingsRepository)
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
      if (ctx.networkSimManager) {
        ctx.networkSimManager.onCpCreated(row.cp_id);
      }
      restored.push(row.cp_id);
    } catch (error) {
      // One row that cannot be rebuilt is not the daemon's end: the others
      // come back, and this one stays in the table for a start that can.
      ctx.storedSelection.delete(row.cp_id);
      ctx.storedParams.delete(row.cp_id);
      // A step after `instantiate` failed: the service is registered but was
      // never wired. Take it out, or it sits in list() and never connects.
      const partial = ctx.services.get(row.cp_id);
      if (partial) {
        ctx.unsubscribes.get(row.cp_id)?.();
        ctx.unsubscribes.delete(row.cp_id);
        ctx.services.delete(row.cp_id);
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
  if (opts.connect !== false) ctx.connectRestored(restored);
  return restored;
}
