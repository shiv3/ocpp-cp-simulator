import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import { perChargePointTables } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/schema";
import { buildUpsert } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/upsert";
import type { ChargePointInitOptions } from "../../types";
import { labelsColumn } from "./rowMapping";

export function persistBootNotification(
  database: Database | null,
  cpId: string,
  bootNotification: NonNullable<ChargePointInitOptions["bootNotification"]>,
): void {
  if (!database) return;
  database.run("UPDATE charge_points SET boot_notif = ? WHERE cp_id = ?", [
    JSON.stringify(bootNotification),
    cpId,
  ]);
}

export function persistSecurityCredentials(
  database: Database | null,
  cpId: string,
  change: { securityProfile?: number; authorizationKey?: string },
): void {
  if (!database) return;
  if (change.authorizationKey !== undefined) {
    database.run(
      "UPDATE charge_points SET authorization_key = ? WHERE cp_id = ?",
      [change.authorizationKey, cpId],
    );
  }
  if (change.securityProfile !== undefined) {
    database.run(
      "UPDATE charge_points SET security_profile = ? WHERE cp_id = ?",
      [change.securityProfile, cpId],
    );
  }
}

/**
 * `behaviorsColumn`, when given, is written as the `behaviors` value instead
 * of the init's own, `paramsColumn` likewise for `behavior_params` (see
 * {@link storedSelection}).
 */
export function persistCreate(
  database: Database | null,
  init: ChargePointInitOptions,
  behaviorsColumn?: string | null,
  paramsColumn?: string | null,
): void {
  if (!database) return;
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
      [
        "tx_updated_meter_values",
        init.txUpdatedMeterValues === undefined
          ? null
          : init.txUpdatedMeterValues
            ? 1
            : 0,
      ],
      ["inbound_validation", init.inboundValidation ?? null],
      [
        "capability_profile",
        init.capabilityProfile ? JSON.stringify(init.capabilityProfile) : null,
      ],
      [
        "charger_capabilities",
        init.chargerCapabilities
          ? JSON.stringify(init.chargerCapabilities)
          : null,
      ],
      [
        "transport_options",
        init.transport ? JSON.stringify(init.transport) : null,
      ],
      [
        "reservation_authorize_id_tag",
        init.reservationAuthorizeIdTag ? 1 : null,
      ],
      [
        "meter_value_decimal_separator",
        init.meterValueDecimalSeparator === "," ? "," : null,
      ],
      ["empty_meter_values", init.emptyMeterValues ? 1 : null],
    ],
    ["cp_id"],
    // The row keeps the time it was first created.
    ["created_at"],
  );
  database.run(sql, params);
}

export function persistRemove(database: Database | null, cpId: string): void {
  if (!database) return;
  // Cascade to every `cp_id`-keyed table. There is no FK in the schema, so
  // the cleanup is explicit — and the list is the schema's own (#326):
  // hand-maintained here it covered three of the eight, and the rows left
  // behind (settings, profiles, configuration, queued CALLs, logs, the
  // desired-connected flag) came back when the same cpId was re-created.
  // #314's watch rows ride the same list, whether or not this daemon runs
  // with `--watch`.
  for (const table of perChargePointTables()) {
    try {
      database.run(`DELETE FROM ${table} WHERE cp_id = ?`, [cpId]);
    } catch (err) {
      // A DB from before a table existed: keep deleting the rest.
      console.warn(
        `[CPRegistry] could not delete ${cpId} rows from ${table}:`,
        err,
      );
    }
  }
}
