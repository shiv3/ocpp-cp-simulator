import type { SimulatorConfigInput, WireSimulatorConfig } from "../protocol";
import type { Config } from "../store/store";

export function getConfigBasicAuthPassword(
  config: WireSimulatorConfig | SimulatorConfigInput | null,
): string {
  if (!config) return "";
  const settings = config.basicAuthSettings as { password?: unknown };
  return typeof settings.password === "string" ? settings.password : "";
}

/**
 * A previously-saved config, only used here to recover the write-only
 * password when the caller's `next` doesn't resupply one. Accepts either
 * adapter's own config shape (`Config` in the browser, `SimulatorConfigInput`
 * on the daemon) — both carry `basicAuthSettings.password` — so one merge
 * implementation covers both without coupling this shared module to either
 * adapter's specific type.
 */
interface ExistingConfigWithPassword {
  readonly basicAuthSettings: { readonly password?: string | null };
}

/**
 * Reconstructs a full config from `next`, carrying over `existing`'s
 * basic-auth password when `next` didn't resupply one (the wire schema never
 * round-trips a stored password back to the client, so a save that isn't
 * changing credentials arrives with `password` empty/undefined). Shared by
 * the browser (Local) and daemon (Registry) adapters — see
 * `RegistryChargePointService.saveConfig` — so a field added to
 * `SimulatorConfigInput` only needs handling once.
 */
export function mergeWriteOnlyConfigSecrets(
  next: SimulatorConfigInput | null,
  existing: ExistingConfigWithPassword | null,
): Config | null {
  if (next === null) return null;

  const suppliedPassword = next.basicAuthSettings.password;
  const password =
    typeof suppliedPassword === "string" && suppliedPassword.length > 0
      ? suppliedPassword
      : (existing?.basicAuthSettings.password ?? "");

  return {
    wsURL: next.wsURL,
    ChargePointID: next.ChargePointID,
    connectorNumber: next.connectorNumber,
    tagID: next.tagID,
    ocppVersion: next.ocppVersion,
    basicAuthSettings: {
      enabled: next.basicAuthSettings.enabled,
      username: next.basicAuthSettings.username,
      password,
    },
    autoMeterValueSetting: {
      enabled: next.autoMeterValueSetting.enabled,
      interval: next.autoMeterValueSetting.interval,
      value: next.autoMeterValueSetting.value,
    },
    Experimental: next.Experimental
      ? {
          ChargePointIDs: next.Experimental.ChargePointIDs.map((cp) => ({
            ChargePointID: cp.ChargePointID,
            ConnectorNumber: cp.ConnectorNumber,
          })),
          TagIDs: [...next.Experimental.TagIDs],
        }
      : null,
    BootNotification: next.BootNotification
      ? { ...next.BootNotification }
      : null,
  };
}
