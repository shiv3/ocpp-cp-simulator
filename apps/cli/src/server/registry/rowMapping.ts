import {
  DISABLED_ACTION_ERROR_CODES,
  STATUS_TRANSITION_MODES,
  type ChargePointCapabilityProfile,
  type DisabledActionErrorCode,
  type StatusTransitionMode,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/CapabilityProfile";
import {
  chargerCapabilitiesProblem,
  type ChargerCapabilities,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargerCapabilities";
import type { JsonObject } from "@ocpp-cp-simulator/contracts/behavior";
import {
  behaviorFitProblem,
  behaviorShapeProblem,
} from "@ocpp-cp-simulator/core/cp/application/engine/behaviorFit";
import type { BehaviorLibrary } from "../../behavior/BehaviorLibrary";
import type { ChargePointInitOptions } from "../../types";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/wsUrlWithBasic";
import {
  labelsSchema,
  normalizeLabels,
  type Labels,
} from "@ocpp-cp-simulator/contracts/labels";
import { transportConfigSchema } from "@ocpp-cp-simulator/contracts/transportConfig";

export interface ChargePointRow {
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
  reservation_authorize_id_tag: number | null;
  capability_profile: string | null;
  charger_capabilities: string | null;
  transport_options: string | null;
}

/** NULL for "no labels", the empty map included (see `normalizeLabels`). */
export function labelsColumn(labels: Labels | undefined): string | null {
  const normalized = normalizeLabels(labels);
  return normalized ? JSON.stringify(normalized) : null;
}

/**
 * Read back through the wire schema rather than trusted: every list item and
 * registry push is validated against it, so one hand-edited or corrupted row
 * would otherwise fail every `cp.list` instead of losing its own labels.
 */
export function restoreLabels(row: ChargePointRow): Labels | undefined {
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
export function restoreTransport(
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
export function restoreBehaviors(
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
export function restoreBehaviorParams(
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

export function restoreChargerCapabilities(
  raw: string | null,
): { chargerCapabilities: ChargerCapabilities } | Record<string, never> {
  const parsed = safeJsonParse<unknown>(raw);
  if (parsed === null || chargerCapabilitiesProblem(parsed) !== null) {
    return {};
  }
  return { chargerCapabilities: parsed as ChargerCapabilities };
}

export function restoreCapabilityProfile(
  raw: string | null,
): { capabilityProfile: ChargePointCapabilityProfile } | Record<string, never> {
  const parsed = safeJsonParse<unknown>(raw);
  if (typeof parsed !== "object" || parsed === null) return {};
  const {
    disabledActions,
    triggerMessageTargets,
    disabledActionErrorCode,
    statusTransitions,
  } = parsed as Record<string, unknown>;
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
  // A value this build does not know restores as absent (the default).
  if (
    (DISABLED_ACTION_ERROR_CODES as readonly unknown[]).includes(
      disabledActionErrorCode,
    )
  ) {
    profile.disabledActionErrorCode =
      disabledActionErrorCode as DisabledActionErrorCode;
  }
  if (
    (STATUS_TRANSITION_MODES as readonly unknown[]).includes(statusTransitions)
  ) {
    profile.statusTransitions = statusTransitions as StatusTransitionMode;
  }
  return { capabilityProfile: profile };
}

export function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function parsePersistedSecurityProfile(
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

/**
 * The fields an update keeps when it omits them: the security-sensitive ones a
 * redacted snapshot cannot send back, and the labels (#446) — an update that
 * does not mention them keeps them, `{}` clears them.
 */
export function preserveOmittedInit(
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
    reservationAuthorizeIdTag:
      next.reservationAuthorizeIdTag ?? existing.reservationAuthorizeIdTag,
    transport: next.transport ?? existing.transport,
    capabilityProfile: next.capabilityProfile ?? existing.capabilityProfile,
    chargerCapabilities:
      next.chargerCapabilities ?? existing.chargerCapabilities,
  };
}

export function mergeTlsOptions(
  existing: OcppTlsOptions | undefined,
  next: OcppTlsOptions,
): OcppTlsOptions {
  return {
    ...(existing ?? {}),
    ...next,
  };
}
